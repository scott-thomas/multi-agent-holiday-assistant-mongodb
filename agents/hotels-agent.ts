/**
 * Hotels Specialist Agent
 *
 * Handles: accommodation search, room pricing, availability, booking creation,
 *          booking retrieval/cancellation, and amenity comparisons.
 *
 * Tools:
 *   - search_hotels              Vector search on hotel documents
 *   - get_hotels_by_destination  Aggregation – hotels for a destination, sorted by price
 *   - get_room_availability      Check available rooms for a specific hotel
 *   - create_booking             INSERT new accommodation booking, returns reference
 *   - get_booking                Retrieve booking by reference
 *   - cancel_booking             Mark booking as CANCELLED
 */

import { ChatOpenAI } from "@langchain/openai";
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from "@langchain/core/prompts";
import { StateGraph, Annotation } from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";
import type { MongoClient } from "mongodb";
import type { MongoDBStore } from "@langchain/langgraph-checkpoint-mongodb";
import { z } from "zod";
import {
  vectorSearch,
  DB_NAMES,
  COLLECTIONS,
  VECTOR_INDEXES,
  generateBookingRef,
} from "../shared/utils";
import {
  searchFormattedMemories,
  recordInteractionSummary,
  updateUserProfile,
} from "../memory/memory-api";
import { traceStep, emitStep } from "../shared/tracer";
import "dotenv/config";

// ─── Graph State ─────────────────────────────────────────────────────────────

const HotelsState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
  }),
});

// ─── Main exported function ───────────────────────────────────────────────────

export async function callHotelsAgent(
  client: MongoClient,
  store: MongoDBStore,
  query: string,
  threadId: string,
  userId: string
): Promise<string> {
  console.log(`[Hotels Agent] callHotelsAgent userId=${userId} threadId=${threadId}`);
  const userMemories = await searchFormattedMemories(store, userId, query);
  const hotelsCollection = client.db(DB_NAMES.HOLIDAY).collection(COLLECTIONS.HOTELS);
  const bookingsCollection = client.db(DB_NAMES.HOLIDAY).collection(COLLECTIONS.BOOKINGS);

  // ─── Tools ─────────────────────────────────────────────────────────────────

  /** Semantic search across hotel documents. */
  const searchHotelsTool = tool(
    async ({ query: q, limit = 8 }) => {
      console.log("[Hotels Agent] search_hotels:", q);
      const results = await vectorSearch(
        client,
        DB_NAMES.HOLIDAY,
        COLLECTIONS.HOTELS,
        VECTOR_INDEXES.HOTELS,
        q,
        limit
      );
      return results.length
        ? JSON.stringify(results)
        : "No matching hotels found for this query.";
    },
    {
      name: "search_hotels",
      description:
        "Search for hotels and accommodation using natural language. " +
        "Accepts queries like 'beachfront resort in Santorini with pool', " +
        "'budget hotel Barcelona city centre', 'luxury villa Algarve sea view'. " +
        "Returns matching hotel records with pricing and amenities.",
      schema: z.object({
        query: z.string().describe("Natural language accommodation search query"),
        limit: z
          .number()
          .optional()
          .default(8)
          .describe("Max number of hotel results"),
      }),
    }
  );

  /** MongoDB aggregation to find hotels for a destination. */
  const getHotelsByDestinationTool = tool(
    async ({ city, country, star_rating, max_price_per_night }) => {
      console.log("[Hotels Agent] get_hotels_by_destination:", city, country ?? "");

      const matchFilter: Record<string, unknown> = {};
      if (city) matchFilter["metadata.city"] = { $regex: city, $options: "i" };
      if (country) matchFilter["metadata.country"] = { $regex: country, $options: "i" };
      if (star_rating) matchFilter["metadata.star_rating"] = { $gte: star_rating };

      const pipeline = [
        ...(Object.keys(matchFilter).length ? [{ $match: matchFilter }] : []),
        { $unwind: "$metadata.room_types" },
        ...(max_price_per_night
          ? [{ $match: { "metadata.room_types.price_per_night": { $lte: max_price_per_night } } }]
          : []),
        { $sort: { "metadata.room_types.price_per_night": 1 } },
        {
          $group: {
            _id: "$metadata.hotel_id",
            name: { $first: "$metadata.name" },
            city: { $first: "$metadata.city" },
            country: { $first: "$metadata.country" },
            star_rating: { $first: "$metadata.star_rating" },
            property_type: { $first: "$metadata.property_type" },
            rating: { $first: "$metadata.rating" },
            distance_to_centre_km: { $first: "$metadata.distance_to_centre_km" },
            amenities: { $first: "$metadata.amenities" },
            cheapest_room: { $first: "$metadata.room_types" },
            rooms_available: { $first: "$metadata.availability.rooms_available" },
          },
        },
        { $sort: { "cheapest_room.price_per_night": 1 } },
        { $limit: 10 },
      ];

      const results = await traceStep(
        {
          phase: "mongodb",
          title: "Aggregate hotels by destination",
          detail: `$match + $unwind + $group pipeline on hotels${city ? ` · ${city}` : ""}`,
          db: DB_NAMES.HOLIDAY,
          collection: COLLECTIONS.HOTELS,
          agent: "hotels",
        },
        () => hotelsCollection.aggregate(pipeline).toArray(),
        (r) => ({ detail: `Returned ${r.length} hotel(s), cheapest-room first` })
      );
      return results.length
        ? JSON.stringify(results)
        : `No hotels found in ${city ?? "the requested destination"}.`;
    },
    {
      name: "get_hotels_by_destination",
      description:
        "Get available hotels for a destination, sorted by price ascending. " +
        "Supports filtering by star rating and maximum price per night.",
      schema: z.object({
        city: z.string().optional().describe("City name (e.g. Barcelona, Santorini)"),
        country: z.string().optional().describe("Country name (e.g. Spain, Greece)"),
        star_rating: z.number().int().min(1).max(5).optional().describe("Minimum star rating"),
        max_price_per_night: z.number().optional().describe("Maximum price per night"),
      }),
    }
  );

  /** Check room availability for a specific hotel. */
  const getRoomAvailabilityTool = tool(
    async ({ hotel_name, check_in, check_out }) => {
      console.log("[Hotels Agent] get_room_availability:", hotel_name);

      const hotel = await traceStep(
        {
          phase: "mongodb",
          title: "Look up room availability",
          detail: `findOne on hotels · "${hotel_name}"`,
          db: DB_NAMES.HOLIDAY,
          collection: COLLECTIONS.HOTELS,
          agent: "hotels",
        },
        () =>
          hotelsCollection.findOne(
            { "metadata.name": { $regex: hotel_name, $options: "i" } },
            {
              projection: {
                _id: 0,
                "metadata.name": 1,
                "metadata.room_types": 1,
                "metadata.availability": 1,
                "metadata.check_in_time": 1,
                "metadata.check_out_time": 1,
                "metadata.star_rating": 1,
              },
            }
          ),
        (h) => ({ detail: h ? `Found "${hotel_name}" with room types` : `"${hotel_name}" not found` })
      );

      if (!hotel) {
        return `Hotel "${hotel_name}" not found in the database.`;
      }

      const nights =
        check_in && check_out
          ? Math.max(
              1,
              Math.round(
                (new Date(check_out).getTime() - new Date(check_in).getTime()) /
                  (1000 * 60 * 60 * 24)
              )
            )
          : null;

      return JSON.stringify({ ...hotel, nights_requested: nights });
    },
    {
      name: "get_room_availability",
      description:
        "Check room types and availability for a specific hotel. " +
        "Optionally provide check-in and check-out dates to calculate total cost.",
      schema: z.object({
        hotel_name: z.string().describe("Hotel name (partial match supported)"),
        check_in: z.string().optional().describe("ISO date e.g. 2026-07-15"),
        check_out: z.string().optional().describe("ISO date e.g. 2026-07-22"),
      }),
    }
  );

  /** Create a new accommodation booking. */
  const createBookingTool = tool(
    async ({
      guest_first_name,
      guest_last_name,
      guest_email,
      hotel_name,
      room_type,
      check_in,
      check_out,
      num_guests,
      price_per_night,
      currency,
      breakfast_included,
      special_requests,
    }) => {
      console.log("[Hotels Agent] create_booking:", hotel_name, guest_last_name);

      const bookingRef = generateBookingRef();
      const now = new Date().toISOString();
      const nights = Math.max(
        1,
        Math.round(
          (new Date(check_out).getTime() - new Date(check_in).getTime()) /
            (1000 * 60 * 60 * 24)
        )
      );
      const total_price = price_per_night * nights;

      const booking = {
        booking_ref: bookingRef,
        guest: {
          first_name: guest_first_name,
          last_name: guest_last_name,
          email: guest_email,
          num_guests,
        },
        accommodation: {
          hotel_name,
          room_type,
          check_in,
          check_out,
          nights,
          breakfast_included: breakfast_included ?? false,
        },
        price: {
          price_per_night,
          total_price,
          currency: currency.toUpperCase(),
          nights,
        },
        special_requests: special_requests ?? null,
        status: "CONFIRMED",
        booking_type: "hotel",
        created_by_user_id: userId,
        created_at: now,
        updated_at: now,
      };

      await traceStep(
        {
          phase: "mongodb",
          title: "Create accommodation booking",
          detail: `insertOne into bookings · ref ${bookingRef}`,
          db: DB_NAMES.HOLIDAY,
          collection: COLLECTIONS.BOOKINGS,
          agent: "hotels",
        },
        () => bookingsCollection.insertOne(booking)
      );

      await updateUserProfile(store, userId, {
        last_booking_ref: bookingRef,
        last_booked_hotel: hotel_name,
      });

      return JSON.stringify({
        success: true,
        booking_ref: bookingRef,
        message: `Accommodation booked! Your reference is: ${bookingRef}`,
        booking: { ...booking },
      });
    },
    {
      name: "create_booking",
      description:
        "Create a new hotel / accommodation booking. " +
        "Returns an 8-character booking reference the guest can use to manage their stay.",
      schema: z.object({
        guest_first_name: z.string(),
        guest_last_name: z.string(),
        guest_email: z.string().email(),
        hotel_name: z.string().describe("Full hotel name"),
        room_type: z.enum(["standard", "deluxe", "suite", "family", "penthouse"]),
        check_in: z.string().describe("ISO date e.g. 2026-07-15"),
        check_out: z.string().describe("ISO date e.g. 2026-07-22"),
        num_guests: z.number().int().min(1),
        price_per_night: z.number().describe("Price per night for the selected room"),
        currency: z.string().default("EUR"),
        breakfast_included: z.boolean().optional(),
        special_requests: z.string().optional().describe("e.g. high floor, cot required"),
      }),
    }
  );

  /** Retrieve a booking by reference. */
  const getBookingTool = tool(
    async ({ booking_ref }) => {
      console.log("[Hotels Agent] get_booking:", booking_ref);

      const doc = await traceStep(
        {
          phase: "mongodb",
          title: "Retrieve booking",
          detail: `findOne on bookings · ref ${booking_ref.toUpperCase()}`,
          db: DB_NAMES.HOLIDAY,
          collection: COLLECTIONS.BOOKINGS,
          agent: "hotels",
        },
        () =>
          bookingsCollection.findOne(
            { booking_ref: booking_ref.toUpperCase() },
            { projection: { _id: 0 } }
          ),
        (d) => ({ detail: d ? `Found booking ${booking_ref.toUpperCase()}` : `No booking ${booking_ref.toUpperCase()}` })
      );

      if (!doc) {
        return `No booking found with reference: ${booking_ref}. Please check and try again.`;
      }
      return JSON.stringify(doc);
    },
    {
      name: "get_booking",
      description: "Retrieve full booking details using an 8-character booking reference.",
      schema: z.object({
        booking_ref: z.string().describe("8-character booking reference, e.g. AB12CD34"),
      }),
    }
  );

  /** Cancel a booking by reference. */
  const cancelBookingTool = tool(
    async ({ booking_ref, reason }) => {
      console.log("[Hotels Agent] cancel_booking:", booking_ref);

      const existing = await bookingsCollection.findOne({
        booking_ref: booking_ref.toUpperCase(),
      });

      if (!existing) {
        return `No booking found with reference: ${booking_ref}.`;
      }
      if (existing.status === "CANCELLED") {
        return `Booking ${booking_ref} is already cancelled.`;
      }

      await traceStep(
        {
          phase: "mongodb",
          title: "Cancel booking",
          detail: `updateOne on bookings · ref ${booking_ref.toUpperCase()} → CANCELLED`,
          db: DB_NAMES.HOLIDAY,
          collection: COLLECTIONS.BOOKINGS,
          agent: "hotels",
        },
        () =>
          bookingsCollection.updateOne(
            { booking_ref: booking_ref.toUpperCase() },
            {
              $set: {
                status: "CANCELLED",
                cancellation_reason: reason ?? "Cancelled by guest request",
                updated_at: new Date().toISOString(),
              },
            }
          )
      );

      return JSON.stringify({
        success: true,
        booking_ref: booking_ref.toUpperCase(),
        message: `Booking ${booking_ref.toUpperCase()} has been successfully cancelled.`,
        previous_status: existing.status,
      });
    },
    {
      name: "cancel_booking",
      description:
        "Cancel an existing accommodation booking by reference. " +
        "Cancellation fees may apply depending on the hotel policy.",
      schema: z.object({
        booking_ref: z.string().describe("8-character booking reference to cancel"),
        reason: z.string().optional().describe("Reason for cancellation"),
      }),
    }
  );

  const tools = [
    searchHotelsTool,
    getHotelsByDestinationTool,
    getRoomAvailabilityTool,
    createBookingTool,
    getBookingTool,
    cancelBookingTool,
  ];
  const toolNode = new ToolNode<typeof HotelsState.State>(tools);

  // ─── Model ─────────────────────────────────────────────────────────────────

  const model = new ChatOpenAI({ model: "gpt-4o" }).bindTools(tools);

  // ─── Nodes ─────────────────────────────────────────────────────────────────

  async function callModel(state: typeof HotelsState.State) {
    console.log(`[Hotels Agent] → agent node (messages: ${state.messages.length})`);
    const prompt = ChatPromptTemplate.fromMessages([
      [
        "system",
        `You are the Accommodation Specialist. Your role is to help travellers 
find, compare, and book the perfect hotel or accommodation for their holiday.

You have access to a hotel database via vector search and aggregation tools.
Always present accommodation clearly: hotel name, location, star rating, room types, 
price per night (with currency), key amenities, and check-in/check-out policies.

When comparing options, summarise in a structured list or table.
When booking, confirm all details with the guest before proceeding: 
name, email, hotel, room type, dates, number of guests, and price per night.
Always confirm the booking reference clearly after a successful reservation.

When cancelling, mention that cancellation fees may apply per the hotel policy 
(the Policy specialist can provide specific details).

User context from previous sessions (may contain previous bookings):
{memories}

Current time: {time}
Available tools: {tool_names}`,
      ],
      new MessagesPlaceholder("messages"),
    ]);

    const formatted = await prompt.formatMessages({
      memories: userMemories,
      time: new Date().toISOString(),
      tool_names: tools.map((t) => t.name).join(", "),
      messages: state.messages,
    });

    const result = await model.invoke(formatted);
    return { messages: [result] };
  }

  function shouldContinue(state: typeof HotelsState.State) {
    const last = state.messages[state.messages.length - 1] as AIMessage;
    const next = last.tool_calls?.length ? "tools" : "__end__";
    if (next === "tools") {
      emitStep({
        phase: "agent",
        title: `Hotels agent calling: ${last.tool_calls!.map((tc) => tc.name).join(", ")}`,
        detail: "gpt-4o selected tools to gather the data it needs",
        agent: "hotels",
      });
    }
    console.log(
      `[Hotels Agent] → shouldContinue: ${next}${
        next === "tools" ? ` (${last.tool_calls!.map((tc) => tc.name).join(", ")})` : ""
      }`
    );
    return next;
  }

  // ─── Graph ─────────────────────────────────────────────────────────────────

  const workflow = new StateGraph(HotelsState)
    .addNode("agent", callModel)
    .addNode("tools", toolNode)
    .addEdge("__start__", "agent")
    .addConditionalEdges("agent", shouldContinue)
    .addEdge("tools", "agent");

  const checkpointer = new MongoDBSaver({ client, dbName: DB_NAMES.MEMORY });
  const app = workflow.compile({ checkpointer });

  const finalState = await app.invoke(
    { messages: [new HumanMessage(query)] },
    { recursionLimit: 15, configurable: { thread_id: `${threadId}_hotels` } }
  );

  const responseContent =
    finalState.messages[finalState.messages.length - 1].content as string;

  await recordInteractionSummary(
    store,
    userId,
    "hotels",
    `Query: "${query.slice(0, 120)}". Summary: "${responseContent.slice(0, 250)}"`
  );

  return responseContent;
}

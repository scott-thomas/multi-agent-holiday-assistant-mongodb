/**
 * Transport Specialist Agent
 *
 * Handles: how to get from A to B — flights, trains, car hire, transfers,
 *          ferry routes, and multi-leg journey planning.
 *
 * Tools:
 *   - search_transport_options   Vector search on transport documents
 *   - get_routes_between         Direct routes between two cities
 *   - get_local_transfers        Airport/station to hotel transfer options
 *   - book_transport             Create a transport booking (flight/train/transfer)
 *   - get_transport_booking      Retrieve a transport booking by reference
 *   - cancel_transport_booking   Cancel a transport booking
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
  DB_NAMES,
  COLLECTIONS,
  generateBookingRef,
} from "../shared/utils";
import {
  searchFormattedMemories,
  recordInteractionSummary,
  updateUserProfile,
} from "../memory/memory-api";
import "dotenv/config";

// ─── Graph State ─────────────────────────────────────────────────────────────

const TransportState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
  }),
});

// ─── Main exported function ───────────────────────────────────────────────────

export async function callTransportAgent(
  client: MongoClient,
  store: MongoDBStore,
  query: string,
  threadId: string,
  userId: string
): Promise<string> {
  console.log(`[Transport Agent] callTransportAgent userId=${userId} threadId=${threadId}`);
  const userMemories = await searchFormattedMemories(store, userId, query);
  const bookingsCollection = client.db(DB_NAMES.HOLIDAY).collection(COLLECTIONS.BOOKINGS);

  // ─── Tools ─────────────────────────────────────────────────────────────────

  /**
   * Research transport options using OpenAI's general knowledge.
   * We synthesise results rather than looking up a seeded transport DB,
   * so this tool formats a structured prompt and returns the LLM's knowledge.
   */
  const searchTransportOptionsTool = tool(
    async ({ origin, destination, travel_date, transport_type }) => {
      console.log("[Transport Agent] search_transport_options:", origin, "→", destination);

      // Use a mini-LLM to synthesise realistic transport options
      const researchModel = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0.3 });
      const response = await researchModel.invoke(
        `You are a European travel expert. Provide realistic transport options from ${origin} to ${destination}` +
        (travel_date ? ` on ${travel_date}` : "") +
        (transport_type ? ` (focus on: ${transport_type})` : "") +
        `. Include:
- All practical transport modes (flights, trains, coaches, ferries where relevant)
- Approximate journey time and cost range in EUR
- Key operators (airlines, rail companies, bus companies)
- Transfer/connection points if required
- Tips on which option is best for different priorities (speed, cost, comfort, eco)

Format as a structured list. Be concise but informative.`
      );

      return typeof response.content === "string" ? response.content : JSON.stringify(response.content);
    },
    {
      name: "search_transport_options",
      description:
        "Research all practical ways to travel from one place to another. " +
        "Covers flights, trains (Eurostar, Renfe, SNCF, etc.), coaches, ferries, and transfers. " +
        "Returns journey times, cost estimates, and operator recommendations.",
      schema: z.object({
        origin: z.string().describe("Starting city or airport (e.g. London, Paris CDG)"),
        destination: z.string().describe("Destination city or airport (e.g. Barcelona, Santorini)"),
        travel_date: z.string().optional().describe("ISO date e.g. 2026-07-15"),
        transport_type: z
          .enum(["flight", "train", "coach", "ferry", "car_hire", "transfer", "any"])
          .optional()
          .default("any"),
      }),
    }
  );

  /**
   * Get direct routes between two cities from the bookings collection,
   * or return advisory information if none are found.
   */
  const getRoutesBetweenTool = tool(
    async ({ origin, destination }) => {
      console.log("[Transport Agent] get_routes_between:", origin, "→", destination);

      // Check if any transport bookings exist for this route
      const existing = await bookingsCollection
        .find(
          {
            booking_type: "transport",
            "transport.origin": { $regex: origin, $options: "i" },
            "transport.destination": { $regex: destination, $options: "i" },
          },
          { projection: { _id: 0 } }
        )
        .sort({ created_at: -1 })
        .limit(5)
        .toArray();

      if (existing.length) {
        return JSON.stringify({
          message: `Found ${existing.length} previously booked transport option(s) for this route.`,
          bookings: existing,
        });
      }

      // No bookings found — advise use of search_transport_options
      return JSON.stringify({
        message: `No existing bookings for ${origin} → ${destination}. Use search_transport_options to research options.`,
        origin,
        destination,
      });
    },
    {
      name: "get_routes_between",
      description:
        "Check for existing or previously booked transport options between two cities. " +
        "Use search_transport_options first to research available routes.",
      schema: z.object({
        origin: z.string().describe("Origin city or region"),
        destination: z.string().describe("Destination city or region"),
      }),
    }
  );

  /**
   * Provide local transfer / getting around information.
   */
  const getLocalTransfersTool = tool(
    async ({ location, from_point, to_point }) => {
      console.log("[Transport Agent] get_local_transfers:", location);

      const researchModel = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0.3 });
      const response = await researchModel.invoke(
        `You are a local transport expert for ${location}. ` +
        `Provide practical advice for getting from ${from_point} to ${to_point} in or around ${location}. ` +
        `Include: taxi/rideshare, public transport, shuttle buses, car hire, approximate costs in EUR and journey times. ` +
        `Mention any tips (pre-book, avoid rush hour, etc.). Be concise.`
      );

      return typeof response.content === "string" ? response.content : JSON.stringify(response.content);
    },
    {
      name: "get_local_transfers",
      description:
        "Get advice on local transfers and getting around at a destination — " +
        "e.g. airport to hotel, port to city centre, inter-island ferries.",
      schema: z.object({
        location: z.string().describe("The destination or city (e.g. Santorini, Barcelona)"),
        from_point: z.string().describe("Starting point (e.g. Santorini Airport, Piraeus Port)"),
        to_point: z.string().describe("End point (e.g. Oia village, city centre hotel)"),
      }),
    }
  );

  /** Create a transport booking record. */
  const bookTransportTool = tool(
    async ({
      passenger_first_name,
      passenger_last_name,
      passenger_email,
      transport_type,
      operator,
      origin,
      destination,
      departure_datetime,
      arrival_datetime,
      num_passengers,
      price_per_person,
      currency,
      booking_class,
      reference_number,
    }) => {
      console.log("[Transport Agent] book_transport:", transport_type, origin, "→", destination);

      const bookingRef = generateBookingRef();
      const now = new Date().toISOString();
      const total_price = price_per_person * num_passengers;

      const booking = {
        booking_ref: bookingRef,
        passenger: {
          first_name: passenger_first_name,
          last_name: passenger_last_name,
          email: passenger_email,
          num_passengers,
        },
        transport: {
          type: transport_type,
          operator,
          origin,
          destination,
          departure: departure_datetime,
          arrival: arrival_datetime,
          booking_class: booking_class ?? "STANDARD",
          operator_reference: reference_number ?? null,
        },
        price: {
          price_per_person,
          total_price,
          currency: currency.toUpperCase(),
          num_passengers,
        },
        status: "CONFIRMED",
        booking_type: "transport",
        created_by_user_id: userId,
        created_at: now,
        updated_at: now,
      };

      await bookingsCollection.insertOne(booking);

      await updateUserProfile(store, userId, {
        last_transport_ref: bookingRef,
        last_transport_route: `${origin} → ${destination}`,
      });

      return JSON.stringify({
        success: true,
        booking_ref: bookingRef,
        message: `Transport booked! Your reference is: ${bookingRef}`,
        booking: { ...booking },
      });
    },
    {
      name: "book_transport",
      description:
        "Create a transport booking (flight, train, coach, ferry, transfer). " +
        "Returns an 8-character booking reference.",
      schema: z.object({
        passenger_first_name: z.string(),
        passenger_last_name: z.string(),
        passenger_email: z.string().email(),
        transport_type: z.enum(["flight", "train", "coach", "ferry", "transfer", "car_hire"]),
        operator: z.string().describe("e.g. Ryanair, Eurostar, FlixBus, ATOL"),
        origin: z.string().describe("Departure city or terminal"),
        destination: z.string().describe("Arrival city or terminal"),
        departure_datetime: z.string().describe("ISO 8601 datetime"),
        arrival_datetime: z.string().describe("ISO 8601 datetime"),
        num_passengers: z.number().int().min(1),
        price_per_person: z.number(),
        currency: z.string().default("EUR"),
        booking_class: z.string().optional().describe("e.g. ECONOMY, BUSINESS, STANDARD, FIRST"),
        reference_number: z.string().optional().describe("Operator's own reference number"),
      }),
    }
  );

  /** Retrieve a transport booking by reference. */
  const getTransportBookingTool = tool(
    async ({ booking_ref }) => {
      console.log("[Transport Agent] get_transport_booking:", booking_ref);

      const doc = await bookingsCollection.findOne(
        { booking_ref: booking_ref.toUpperCase(), booking_type: "transport" },
        { projection: { _id: 0 } }
      );

      if (!doc) {
        return `No transport booking found with reference: ${booking_ref}.`;
      }
      return JSON.stringify(doc);
    },
    {
      name: "get_transport_booking",
      description: "Retrieve a transport booking (flight/train/transfer) by its 8-character reference.",
      schema: z.object({
        booking_ref: z.string().describe("8-character booking reference"),
      }),
    }
  );

  /** Cancel a transport booking. */
  const cancelTransportBookingTool = tool(
    async ({ booking_ref, reason }) => {
      console.log("[Transport Agent] cancel_transport_booking:", booking_ref);

      const existing = await bookingsCollection.findOne({
        booking_ref: booking_ref.toUpperCase(),
        booking_type: "transport",
      });

      if (!existing) {
        return `No transport booking found with reference: ${booking_ref}.`;
      }
      if (existing.status === "CANCELLED") {
        return `Transport booking ${booking_ref} is already cancelled.`;
      }

      await bookingsCollection.updateOne(
        { booking_ref: booking_ref.toUpperCase() },
        {
          $set: {
            status: "CANCELLED",
            cancellation_reason: reason ?? "Cancelled by passenger request",
            updated_at: new Date().toISOString(),
          },
        }
      );

      return JSON.stringify({
        success: true,
        booking_ref: booking_ref.toUpperCase(),
        message: `Transport booking ${booking_ref.toUpperCase()} has been cancelled.`,
        previous_status: existing.status,
      });
    },
    {
      name: "cancel_transport_booking",
      description: "Cancel a transport booking by reference.",
      schema: z.object({
        booking_ref: z.string().describe("8-character booking reference to cancel"),
        reason: z.string().optional(),
      }),
    }
  );

  const tools = [
    searchTransportOptionsTool,
    getRoutesBetweenTool,
    getLocalTransfersTool,
    bookTransportTool,
    getTransportBookingTool,
    cancelTransportBookingTool,
  ];
  const toolNode = new ToolNode<typeof TransportState.State>(tools);

  // ─── Model ─────────────────────────────────────────────────────────────────

  const model = new ChatOpenAI({ model: "gpt-4o" }).bindTools(tools);

  // ─── Nodes ─────────────────────────────────────────────────────────────────

  async function callModel(state: typeof TransportState.State) {
    console.log(`[Transport Agent] → agent node (messages: ${state.messages.length})`);
    const prompt = ChatPromptTemplate.fromMessages([
      [
        "system",
        `You are the Transport Specialist. Your role is to help travellers 
plan and book transport for their holiday — flights, trains, coaches, 
ferries, transfers, and car hire.

When advising on how to get from A to B:
1. Use search_transport_options to research all practical options
2. Compare options across speed, cost, comfort, and environmental impact
3. Suggest connecting routes and local transfer options if needed

When booking transport, confirm all details before proceeding:
passenger name, email, transport type, route, operator, departure time, and price.
Always confirm the booking reference after a successful booking.

You have knowledge of European rail networks (Eurostar, Renfe, SNCF, Trenitalia, 
Deutsche Bahn), budget airlines, ferry routes, and ground transfers.

User context from previous sessions (may include previous bookings or preferences):
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

  function shouldContinue(state: typeof TransportState.State) {
    const last = state.messages[state.messages.length - 1] as AIMessage;
    const next = last.tool_calls?.length ? "tools" : "__end__";
    console.log(
      `[Transport Agent] → shouldContinue: ${next}${
        next === "tools" ? ` (${last.tool_calls!.map((tc) => tc.name).join(", ")})` : ""
      }`
    );
    return next;
  }

  // ─── Graph ─────────────────────────────────────────────────────────────────

  const workflow = new StateGraph(TransportState)
    .addNode("agent", callModel)
    .addNode("tools", toolNode)
    .addEdge("__start__", "agent")
    .addConditionalEdges("agent", shouldContinue)
    .addEdge("tools", "agent");

  const checkpointer = new MongoDBSaver({ client, dbName: DB_NAMES.MEMORY });
  const app = workflow.compile({ checkpointer });

  const finalState = await app.invoke(
    { messages: [new HumanMessage(query)] },
    { recursionLimit: 15, configurable: { thread_id: `${threadId}_transport` } }
  );

  const responseContent =
    finalState.messages[finalState.messages.length - 1].content as string;

  await recordInteractionSummary(
    store,
    userId,
    "transport",
    `Query: "${query.slice(0, 120)}". Summary: "${responseContent.slice(0, 250)}"`
  );

  return responseContent;
}

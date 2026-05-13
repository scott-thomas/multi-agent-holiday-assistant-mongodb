/**
 * Holiday Assistant MongoDB MCP (Model Context Protocol) Server
 *
 * Exposes holiday accommodation and booking data from MongoDB as MCP tools
 * that any MCP-compatible client (Claude Desktop, Cursor, etc.) can call.
 *
 * Run with:  npm run mcp-server
 * Transport: JSON-RPC 2.0 over stdio
 *
 * Tools exposed:
 *   • search_hotels            Semantic vector search on hotel documents
 *   • get_hotels_by_destination  All hotels for a destination, sorted by price
 *   • get_hotel_details        Full details for a specific hotel
 *   • get_booking              Look up a booking by reference
 *   • get_destination_price_stats  Min/avg/max nightly rates for a destination
 */

import { MongoClient } from "mongodb";
import * as readline from "readline";
import "dotenv/config";
import {
  DB_NAMES,
  COLLECTIONS,
  VECTOR_INDEXES,
} from "../shared/utils";

// ─── MCP Types ────────────────────────────────────────────────────────────────

interface MCPRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type MCPToolInputSchema = {
  type: "object";
  properties: Record<string, { type: string; description: string }>;
  required?: string[];
};

interface MCPTool {
  name: string;
  description: string;
  inputSchema: MCPToolInputSchema;
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: MCPTool[] = [
  {
    name: "search_hotels",
    description:
      "Semantic vector search over hotel and accommodation documents. " +
      "Returns the most relevant properties for a natural-language query.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural language query, e.g. 'beachfront resort in Santorini with pool'",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (default: 5)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_hotels_by_destination",
    description:
      "Get all available hotels for a specific city/country, sorted by price ascending.",
    inputSchema: {
      type: "object",
      properties: {
        city: {
          type: "string",
          description: "City name (e.g. Barcelona, Santorini)",
        },
        country: {
          type: "string",
          description: "Country name (optional, e.g. Spain, Greece)",
        },
        star_rating: {
          type: "number",
          description: "Minimum star rating filter (1-5, optional)",
        },
      },
      required: ["city"],
    },
  },
  {
    name: "get_hotel_details",
    description:
      "Retrieve full details for a specific hotel including all room types and amenities.",
    inputSchema: {
      type: "object",
      properties: {
        hotel_name: {
          type: "string",
          description: "Hotel name (partial match supported)",
        },
      },
      required: ["hotel_name"],
    },
  },
  {
    name: "get_booking",
    description: "Look up a holiday booking by its 8-character booking reference.",
    inputSchema: {
      type: "object",
      properties: {
        booking_ref: {
          type: "string",
          description: "8-character booking reference, e.g. AB12CD34",
        },
      },
      required: ["booking_ref"],
    },
  },
  {
    name: "get_destination_price_stats",
    description:
      "Get minimum, average, and maximum nightly rates for a destination, grouped by star rating.",
    inputSchema: {
      type: "object",
      properties: {
        city: {
          type: "string",
          description: "Destination city name",
        },
        country: {
          type: "string",
          description: "Country name (optional)",
        },
      },
      required: ["city"],
    },
  },
];

// ─── Tool handlers ────────────────────────────────────────────────────────────

async function handleSearchHotels(
  client: MongoClient,
  args: Record<string, unknown>
): Promise<unknown> {
  const query = args.query as string;
  const limit = (args.limit as number) ?? 5;

  const coll = client.db(DB_NAMES.HOLIDAY).collection(COLLECTIONS.HOTELS);
  const pipeline = [
    {
      $vectorSearch: {
        index: VECTOR_INDEXES.HOTELS,
        queryText: query,
        numCandidates: 150,
        limit,
      } as Record<string, unknown>,
    },
    {
      $project: {
        _id: 0,
        pageContent: 1,
        "metadata.name": 1,
        "metadata.city": 1,
        "metadata.country": 1,
        "metadata.star_rating": 1,
        "metadata.property_type": 1,
        "metadata.rating": 1,
        "metadata.amenities": 1,
        "metadata.room_types": 1,
        "metadata.distance_to_centre_km": 1,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ];

  return coll.aggregate(pipeline).toArray();
}

async function handleGetHotelsByDestination(
  client: MongoClient,
  args: Record<string, unknown>
): Promise<unknown> {
  const city = args.city as string;
  const country = args.country as string | undefined;
  const starRating = args.star_rating as number | undefined;

  const coll = client.db(DB_NAMES.HOLIDAY).collection(COLLECTIONS.HOTELS);

  const filter: Record<string, unknown> = {
    "metadata.city": { $regex: city, $options: "i" },
  };
  if (country) filter["metadata.country"] = { $regex: country, $options: "i" };
  if (starRating) filter["metadata.star_rating"] = { $gte: starRating };

  return coll
    .find(filter, {
      projection: {
        _id: 0,
        "metadata.name": 1,
        "metadata.city": 1,
        "metadata.country": 1,
        "metadata.star_rating": 1,
        "metadata.property_type": 1,
        "metadata.room_types": 1,
        "metadata.rating": 1,
        "metadata.amenities": 1,
        "metadata.distance_to_centre_km": 1,
        "metadata.availability": 1,
      },
    })
    .sort({ "metadata.room_types.0.price_per_night": 1 })
    .limit(10)
    .toArray();
}

async function handleGetHotelDetails(
  client: MongoClient,
  args: Record<string, unknown>
): Promise<unknown> {
  const hotelName = args.hotel_name as string;
  const coll = client.db(DB_NAMES.HOLIDAY).collection(COLLECTIONS.HOTELS);

  const doc = await coll.findOne(
    { "metadata.name": { $regex: hotelName, $options: "i" } },
    { projection: { _id: 0 } }
  );

  if (!doc) return { error: `No hotel found matching: ${hotelName}` };
  return doc;
}

async function handleGetBooking(
  client: MongoClient,
  args: Record<string, unknown>
): Promise<unknown> {
  const bookingRef = (args.booking_ref as string).toUpperCase();
  const coll = client.db(DB_NAMES.HOLIDAY).collection(COLLECTIONS.BOOKINGS);

  const doc = await coll.findOne({ booking_ref: bookingRef }, { projection: { _id: 0 } });
  if (!doc) return { error: `No booking found with reference: ${bookingRef}` };
  return doc;
}

async function handleGetDestinationPriceStats(
  client: MongoClient,
  args: Record<string, unknown>
): Promise<unknown> {
  const city = args.city as string;
  const country = args.country as string | undefined;
  const coll = client.db(DB_NAMES.HOLIDAY).collection(COLLECTIONS.HOTELS);

  const matchFilter: Record<string, unknown> = {
    "metadata.city": { $regex: city, $options: "i" },
  };
  if (country) matchFilter["metadata.country"] = { $regex: country, $options: "i" };

  const pipeline = [
    { $match: matchFilter },
    { $unwind: "$metadata.room_types" },
    {
      $group: {
        _id: "$metadata.star_rating",
        min_price: { $min: "$metadata.room_types.price_per_night" },
        avg_price: { $avg: "$metadata.room_types.price_per_night" },
        max_price: { $max: "$metadata.room_types.price_per_night" },
        currency: { $first: "$metadata.room_types.currency" },
        property_count: { $addToSet: "$metadata.hotel_id" },
      },
    },
    {
      $project: {
        _id: 0,
        star_rating: "$_id",
        min_price: 1,
        avg_price: 1,
        max_price: 1,
        currency: 1,
        property_count: { $size: "$property_count" },
      },
    },
    { $sort: { star_rating: 1 } },
  ];

  const result = await coll.aggregate(pipeline).toArray();
  if (!result.length) return { error: `No hotels found in ${city}` };
  return result;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

async function main() {
  const client = new MongoClient(process.env.MONGODB_URI as string);

  try {
    await client.connect();
    console.error("[MCP Server] Connected to MongoDB");
  } catch (err) {
    console.error("[MCP Server] Failed to connect to MongoDB:", err);
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  function sendResponse(response: MCPResponse) {
    process.stdout.write(JSON.stringify(response) + "\n");
  }

  function sendError(id: string | number | null, code: number, message: string) {
    sendResponse({ jsonrpc: "2.0", id, error: { code, message } });
  }

  rl.on("line", async (line: string) => {
    let request: MCPRequest;

    try {
      request = JSON.parse(line) as MCPRequest;
    } catch {
      sendError(null, -32700, "Parse error");
      return;
    }

    const { id, method, params } = request;

    try {
      if (method === "initialize") {
        sendResponse({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "holiday-assistant-mcp-server", version: "1.0.0" },
          },
        });
        return;
      }

      if (method === "notifications/initialized") return;

      if (method === "tools/list") {
        sendResponse({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
        return;
      }

      if (method === "tools/call") {
        const toolName = (params?.name as string) ?? "";
        const toolArgs = (params?.arguments as Record<string, unknown>) ?? {};
        let toolResult: unknown;

        switch (toolName) {
          case "search_hotels":
            toolResult = await handleSearchHotels(client, toolArgs);
            break;
          case "get_hotels_by_destination":
            toolResult = await handleGetHotelsByDestination(client, toolArgs);
            break;
          case "get_hotel_details":
            toolResult = await handleGetHotelDetails(client, toolArgs);
            break;
          case "get_booking":
            toolResult = await handleGetBooking(client, toolArgs);
            break;
          case "get_destination_price_stats":
            toolResult = await handleGetDestinationPriceStats(client, toolArgs);
            break;
          default:
            sendError(id, -32601, `Unknown tool: ${toolName}`);
            return;
        }

        sendResponse({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(toolResult, null, 2) }],
          },
        });
        return;
      }

      sendError(id, -32601, `Method not found: ${method}`);
    } catch (err) {
      console.error("[MCP Server] Handler error:", err);
      sendError(id, -32603, "Internal server error");
    }
  });

  rl.on("close", async () => {
    await client.close();
    process.exit(0);
  });

  console.error("[MCP Server] Ready – listening on stdin");
}

main();

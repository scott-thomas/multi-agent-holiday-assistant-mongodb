/**
 * Shared types and utilities used across all agents and modules.
 * Domain: holiday planning, hotel accommodation, travel, and booking policies.
 */

import type { MongoClient } from "mongodb";
import { traceStep } from "./tracer";

// ─── MongoDB Vector Search (Atlas Auto-Embedding) ─────────────────────────────
//
// Atlas Vector Search auto-embedding (voyage-4) generates vectors server-side
// whenever documents are inserted and when queries are issued via queryText.
// No client-side embedding or Voyage AI API key is required.

/** Run a $vectorSearch aggregation using Atlas auto-embedding (queryText). */
export async function vectorSearch(
  client: MongoClient,
  dbName: string,
  collectionName: string,
  indexName: string,
  queryText: string,
  limit = 10,
  numCandidates = 150
): Promise<Array<{ pageContent: string; score: number; metadata?: Record<string, unknown> }>> {
  const coll = client.db(dbName).collection(collectionName);
  const pipeline = [
    {
      // Atlas auto-embedding embeds queryText server-side using the model
      // configured in the index definition (voyage-4). No queryVector needed.
      $vectorSearch: {
        index: indexName,
        queryText,
        numCandidates,
        limit,
      } as Record<string, unknown>,
    },
    {
      $project: {
        _id: 0,
        pageContent: 1,
        metadata: 1,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ];

  return traceStep(
    {
      phase: "vector_search",
      title: `Vector search · ${collectionName}`,
      detail: `Atlas auto-embedding ($vectorSearch) for "${queryText.slice(0, 80)}"`,
      db: dbName,
      collection: collectionName,
      index: indexName,
      meta: { queryText: queryText.slice(0, 120), limit, numCandidates },
    },
    () =>
      coll
        .aggregate<{ pageContent: string; score: number; metadata?: Record<string, unknown> }>(pipeline)
        .toArray(),
    (results) => ({
      detail: `Embedded query server-side (voyage-4) → ${results.length} match${
        results.length === 1 ? "" : "es"
      }`,
      meta: {
        matches: results.length,
        topScore: results[0]?.score ?? null,
      },
    })
  );
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const DB_NAMES = {
  HOLIDAY: "holiday_db",
  MEMORY: "agent_memory",
} as const;

export const COLLECTIONS = {
  HOTELS: "hotels",
  BOOKINGS: "bookings",
  POLICIES: "travel_policies",
  LONG_TERM_MEMORY: "long_term_memory",
} as const;

export const VECTOR_INDEXES = {
  HOTELS: "hotels_vector_index",
  POLICIES: "policy_vector_index",
  MEMORY: "memory_vector_index",
} as const;

// ─── Agent names ─────────────────────────────────────────────────────────────

export type AgentName = "hotels" | "transport" | "policy";

// ─── Booking reference generator ─────────────────────────────────────────────

/** Generate a random 8-character booking reference. */
export function generateBookingRef(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

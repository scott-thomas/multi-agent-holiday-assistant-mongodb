/**
 * MongoDB Store configuration for long-term memory.
 *
 * Uses MongoDBStore from @langchain/langgraph-checkpoint-mongodb which
 * implements the LangGraph BaseStore interface.  Each user's memories are
 * namespaced under [userId, "memories"], providing complete privacy isolation.
 *
 * Atlas auto-embedding (voyage-4) generates vectors server-side from the
 * `value.content` field that putUserMemory writes onto every memory document.
 * No Voyage AI API key or client-side embedding code is required.
 */

import { MongoDBStore } from "@langchain/langgraph-checkpoint-mongodb";
import type { MongoClient } from "mongodb";
import { DB_NAMES, COLLECTIONS } from "../shared/utils";

let storeInstance: MongoDBStore | null = null;

/**
 * Returns (or creates) the singleton MongoDBStore instance.
 * Must be awaited once during server startup; subsequent calls return immediately.
 */
export async function createStore(client: MongoClient): Promise<MongoDBStore> {
  if (storeInstance) return storeInstance;

  storeInstance = new MongoDBStore({
    client,
    dbName: DB_NAMES.MEMORY,
    collectionName: COLLECTIONS.LONG_TERM_MEMORY,
    // Auto-embedding: Atlas generates vectors server-side using voyage-4.
    // path points to the text field putUserMemory writes in every stored value.
    indexConfig: {
      name: "memory_vector_index",
      model: "voyage-4",
      path: "value.content",
      modality: "text",
    },
    // Expire memories after 90 days; each read resets the clock.
    ttl: {
      defaultTtl: 7_776_000, // 90 days in seconds
      refreshOnRead: true,
    },
  });

  // start() creates the TTL index and the vector search index.
  // If the vector search index already exists (created by Terraform), the
  // MongoDB driver throws IndexAlreadyExists (code 68). That is safe to ignore.
  try {
    await storeInstance.start();
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;
    if (code !== 68) throw err;
    // Index already exists — store is fully operational, nothing to do.
  }
  return storeInstance;
}

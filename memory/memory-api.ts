/**
 * Long-term memory CRUD operations.
 *
 * All data is namespaced by userId – one user can NEVER read another's memories.
 * The store backs onto MongoDB Atlas, so memories persist across restarts,
 * threads, and even across multiple agent instances.
 *
 * Short-term memory (per-thread conversation context) is handled separately by
 * MongoDBSaver (checkpointer) inside each agent graph.
 */

import { MongoDBStore } from "@langchain/langgraph-checkpoint-mongodb";
import { traceStep, emitStep } from "../shared/tracer";

// ─── Types ───────────────────────────────────────────────────────────────────

export type MemoryType = "profile" | "preference" | "fact" | "interaction_summary";

export interface Memory {
  type: MemoryType;
  data: Record<string, unknown>;
  updatedAt: string;
  agentSource?: string; // which agent wrote this memory
}

// ─── Write ───────────────────────────────────────────────────────────────────

/**
 * Persist (or overwrite) a memory entry for a specific user.
 *
 * @param store   - The MongoDBStore instance
 * @param userId  - Unique identifier for the user (determines namespace)
 * @param key     - Logical key, e.g. "profile", "last_hr_query"
 * @param value   - The memory payload
 */
export async function putUserMemory(
  store: MongoDBStore,
  userId: string,
  key: string,
  value: Memory
): Promise<void> {
  // `content` is read by the Atlas auto-embedding index (path: "value.content")
  // to generate the vector for this memory document server-side.
  await traceStep(
    {
      phase: "memory",
      title: `Store long-term memory · ${key}`,
      detail: `Upsert [${value.type}] into namespace [${userId}, "memories"] (auto-embedded server-side)`,
      db: "agent_memory",
      collection: "long_term_memory",
      index: "memory_vector_index",
      meta: { key, type: value.type, agentSource: value.agentSource },
    },
    () =>
      store.put([userId, "memories"], key, {
        ...value,
        content: `[${value.type}] ${key}: ${JSON.stringify(value.data)}`,
      })
  );
}

// ─── Read ────────────────────────────────────────────────────────────────────

/**
 * Retrieve a specific memory entry for a user.
 * Returns null if the key does not exist.
 */
export async function getUserMemory(
  store: MongoDBStore,
  userId: string,
  key: string
): Promise<Memory | null> {
  const result = await store.get([userId, "memories"], key);
  if (!result) return null;
  return result.value as Memory;
}

/**
 * Load all stored memories for a user and format them as a single string
 * suitable for injection into a system prompt.
 *
 * Each memory includes its type, key, and data payload so the LLM has
 * full context without having to re-query the store on every turn.
 */
export async function loadFormattedMemories(
  store: MongoDBStore,
  userId: string
): Promise<string> {
  try {
    // Search with an empty query to list all memories in the namespace.
    const results = await store.search([userId, "memories"], { limit: 30 });

    if (!results || results.length === 0) {
      return "No long-term memories found for this user.";
    }

    const lines = results.map((item) => {
      const mem = item.value as Memory;
      return `[${mem.type}] ${item.key}: ${JSON.stringify(mem.data)}`;
    });

    return `User memories:\n${lines.join("\n")}`;
  } catch {
    // Store may be empty or not yet initialised – that is fine.
    return "No long-term memories found for this user.";
  }
}

// ─── Semantic search ─────────────────────────────────────────────────────────

/**
 * Find memories semantically similar to a query string.
 * Requires a Vector Search index on the long_term_memory collection.
 *
 * Falls back to `loadFormattedMemories` if vector search is unavailable.
 */
export async function searchUserMemories(
  store: MongoDBStore,
  userId: string,
  queryText: string,
  limit = 5
): Promise<Memory[]> {
  try {
    const results = await store.search([userId, "memories"], {
      query: queryText,
      limit,
    });

    return results.map((r) => r.value as Memory);
  } catch {
    return [];
  }
}

/**
 * Semantic version of loadFormattedMemories.
 * Returns only the memories most relevant to the current query, formatted
 * for injection into a system prompt.  Preferred over loadFormattedMemories.
 */
export async function searchFormattedMemories(
  store: MongoDBStore,
  userId: string,
  query: string,
  limit = 5
): Promise<string> {
  try {
    const results = await traceStep(
      {
        phase: "memory",
        title: "Recall long-term memory",
        detail: `Semantic search of namespace [${userId}, "memories"] for relevant context`,
        db: "agent_memory",
        collection: "long_term_memory",
        index: "memory_vector_index",
        meta: { query: query.slice(0, 120), limit },
      },
      () => store.search([userId, "memories"], { query, limit }),
      (r) => ({
        detail: `Retrieved ${r?.length ?? 0} relevant memor${
          (r?.length ?? 0) === 1 ? "y" : "ies"
        } for this user`,
        meta: { matches: r?.length ?? 0 },
      })
    );

    if (!results || results.length === 0) {
      return "No relevant memories found for this user.";
    }

    const lines = results.map((item) => {
      const mem = item.value as Memory;
      return `[${mem.type}] ${item.key}: ${JSON.stringify(mem.data)}`;
    });

    return `Relevant user memories:\n${lines.join("\n")}`;
  } catch {
    return "No long-term memories found for this user.";
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Upsert the user profile memory (preferences, role, etc.). */
export async function updateUserProfile(
  store: MongoDBStore,
  userId: string,
  profileData: Record<string, unknown>
): Promise<void> {
  const existing = await getUserMemory(store, userId, "profile");
  await putUserMemory(store, userId, "profile", {
    type: "profile",
    data: { ...(existing?.data ?? {}), ...profileData },
    updatedAt: new Date().toISOString(),
  });
}

/** Record a summary of the most recent interaction for an agent. */
export async function recordInteractionSummary(
  store: MongoDBStore,
  userId: string,
  agentName: string,
  summary: string
): Promise<void> {
  emitStep({
    phase: "memory",
    title: `Summarise interaction · ${agentName}`,
    detail: "Writing an interaction summary to long-term memory",
    db: "agent_memory",
    collection: "long_term_memory",
    agent: agentName,
  });
  await putUserMemory(store, userId, `last_${agentName}_interaction`, {
    type: "interaction_summary",
    data: { summary, agent: agentName },
    updatedAt: new Date().toISOString(),
    agentSource: agentName,
  });
}

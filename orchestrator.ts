/**
 * Orchestrator Agent – Holiday Planning Assistant
 *
 * Entry point for all user queries. Routes to one of three specialists:
 *   • "hotels"    → Hotels Agent    (search accommodation, pricing, book/cancel stays)
 *   • "transport" → Transport Agent (how to get from A to B, bookings, transfers)
 *   • "policy"    → Policy Agent    (booking rules, cancellation, compliance checks)
 *
 * Memory layers:
 *   - Short-term: MongoDBSaver checkpointer (per thread)
 *   - Long-term:  MongoDBStore namespaced by userId (cross-session, private)
 *
 * Returns { response, agent } so the API/frontend can display routing info.
 */

import { ChatOpenAI } from "@langchain/openai";
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { StateGraph, Annotation } from "@langchain/langgraph";
import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";
import type { MongoClient } from "mongodb";
import type { MongoDBStore } from "@langchain/langgraph-checkpoint-mongodb";
import { z } from "zod";
import { callHotelsAgent } from "./agents/hotels-agent";
import { callTransportAgent } from "./agents/transport-agent";
import { callPolicyAgent } from "./agents/policy-agent";
import {
  searchFormattedMemories,
  updateUserProfile,
  putUserMemory,
} from "./memory/memory-api";
import { DB_NAMES, type AgentName } from "./shared/utils";
import "dotenv/config";

// ─── Orchestrator State ───────────────────────────────────────────────────────

const OrchestratorState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
  }),
  userId: Annotation<string>(),
  userMemories: Annotation<string>(),
  selectedAgent: Annotation<AgentName | null>(),
  agentResponse: Annotation<string | null>(),
});

// ─── Router schema ────────────────────────────────────────────────────────────

const RouterSchema = z.object({
  agent: z.enum(["hotels", "transport", "policy"]),
  reasoning: z.string().describe("One sentence explaining the routing decision"),
});

// ─── Return type ─────────────────────────────────────────────────────────────

export interface OrchestratorResult {
  response: string;
  agent: AgentName;
}

// ─── Main exported function ───────────────────────────────────────────────────

export async function callOrchestrator(
  client: MongoClient,
  store: MongoDBStore,
  query: string,
  threadId: string,
  userId: string
): Promise<OrchestratorResult> {
  console.log(`[Orchestrator] callOrchestrator userId=${userId} threadId=${threadId}`);
  const routerModel = new ChatOpenAI({ model: "gpt-4o-mini" }).withStructuredOutput(
    RouterSchema
  );

  // ─── Node: load_memories ────────────────────────────────────────────────────

  async function loadMemories(_state: typeof OrchestratorState.State) {
    console.log(`[Orchestrator] → load_memories`);
    const memories = await searchFormattedMemories(store, userId, query);
    return { userMemories: memories };
  }

  // ─── Node: classify_intent ─────────────────────────────────────────────────

  async function classifyIntent(state: typeof OrchestratorState.State) {
    console.log(`[Orchestrator] → classify_intent`);
    const systemPrompt = `You are the holiday planning assistant orchestrator. Route the user query to exactly one specialist:

• "hotels"    – Searching for accommodation, comparing hotels, checking room pricing and availability,
                booking or cancelling a hotel stay, viewing an existing accommodation booking,
                resort comparisons, villa rentals, apartment searches

• "transport" – How to get from A to B, transport options between cities, flight/train/coach/ferry advice,
                booking or cancelling a transport ticket, airport transfers, local transfers,
                car hire, multi-leg journey planning

• "policy"    – Booking rules and terms, cancellation policies and fees, payment conditions,
                child or pet policies, accessibility requirements, data protection (GDPR),
                travel insurance guidance, compliance checks for a planned booking

Pick "hotels" for any accommodation/stay/property question.
Pick "transport" for any getting-there/journey/travel route question.
Pick "policy" for any rules/terms/compliance/insurance question.

User context from previous sessions:
${state.userMemories}`;

    const result = await routerModel.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(query),
    ]);

    console.log(`[Orchestrator] → "${result.agent}"  (${result.reasoning})`);
    return { selectedAgent: result.agent as AgentName };
  }

  // ─── Node: call_specialist ─────────────────────────────────────────────────

  async function callSpecialist(state: typeof OrchestratorState.State) {
    console.log(`[Orchestrator] → call_specialist (${state.selectedAgent})`);
    let response: string;

    switch (state.selectedAgent) {
      case "hotels":
        response = await callHotelsAgent(client, store, query, threadId, userId);
        break;
      case "transport":
        response = await callTransportAgent(client, store, query, threadId, userId);
        break;
      case "policy":
        response = await callPolicyAgent(client, store, query, threadId, userId);
        break;
      default:
        response = await callHotelsAgent(client, store, query, threadId, userId);
    }

    return {
      agentResponse: response,
      messages: [new HumanMessage(query), new AIMessage(response)],
    };
  }

  // ─── Node: save_memories ───────────────────────────────────────────────────

  async function saveMemories(state: typeof OrchestratorState.State) {
    console.log(`[Orchestrator] → save_memories`);
    await putUserMemory(store, userId, "last_query", {
      type: "fact",
      data: {
        query: query.slice(0, 200),
        routedTo: state.selectedAgent,
        timestamp: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
      agentSource: "orchestrator",
    });

    await updateUserProfile(store, userId, {
      lastSeen: new Date().toISOString(),
    });

    return {};
  }

  // ─── Graph ─────────────────────────────────────────────────────────────────

  const workflow = new StateGraph(OrchestratorState)
    .addNode("load_memories", loadMemories)
    .addNode("classify_intent", classifyIntent)
    .addNode("call_specialist", callSpecialist)
    .addNode("save_memories", saveMemories)
    .addEdge("__start__", "load_memories")
    .addEdge("load_memories", "classify_intent")
    .addEdge("classify_intent", "call_specialist")
    .addEdge("call_specialist", "save_memories")
    .addEdge("save_memories", "__end__");

  const checkpointer = new MongoDBSaver({ client, dbName: DB_NAMES.MEMORY });
  const app = workflow.compile({ checkpointer });

  const finalState = await app.invoke(
    {
      messages: [new HumanMessage(query)],
      userId,
      userMemories: "",
      selectedAgent: null,
      agentResponse: null,
    },
    {
      recursionLimit: 20,
      configurable: { thread_id: `${threadId}_orchestrator` },
    }
  );

  return {
    response: finalState.agentResponse ?? "Sorry, I was unable to generate a response.",
    agent: (finalState.selectedAgent as AgentName) ?? "hotels",
  };
}


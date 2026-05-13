/**
 * Policy & Compliance Specialist Agent
 *
 * Handles: travel booking policies, cancellation terms, payment rules,
 *          child/pet policies, accessibility, data protection, travel insurance,
 *          and general compliance checks for holiday bookings.
 *
 * Tools:
 *   - search_policy            Vector search on travel policy documents
 *   - get_cancellation_terms   Aggregated cancellation terms for a booking
 *   - get_policy_by_category   Fetch policy documents by category
 *   - check_booking_compliance Validate a booking against applicable policies
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
} from "../shared/utils";
import {
  searchFormattedMemories,
  recordInteractionSummary,
} from "../memory/memory-api";
import "dotenv/config";

// ─── Graph State ─────────────────────────────────────────────────────────────

const PolicyState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
  }),
});

// ─── Main exported function ───────────────────────────────────────────────────

export async function callPolicyAgent(
  client: MongoClient,
  store: MongoDBStore,
  query: string,
  threadId: string,
  userId: string
): Promise<string> {
  console.log(`[Policy Agent] callPolicyAgent userId=${userId} threadId=${threadId}`);
  const userMemories = await searchFormattedMemories(store, userId, query);
  const policyCollection = client.db(DB_NAMES.HOLIDAY).collection(COLLECTIONS.POLICIES);
  const bookingsCollection = client.db(DB_NAMES.HOLIDAY).collection(COLLECTIONS.BOOKINGS);

  // ─── Tools ─────────────────────────────────────────────────────────────────

  /** Vector search over travel policy documents. */
  const searchPolicyTool = tool(
    async ({ question, limit = 4 }) => {
      console.log("[Policy Agent] search_policy:", question);

      try {
        const results = await vectorSearch(
          client,
          DB_NAMES.HOLIDAY,
          COLLECTIONS.POLICIES,
          VECTOR_INDEXES.POLICIES,
          question,
          limit
        );

        if (!results.length) {
          return (
            "No specific policy documents found. " +
            "Please answer using your general knowledge of travel industry practices."
          );
        }
        return JSON.stringify(results);
      } catch {
        return (
          "Policy vector index not yet available – " +
          "please answer from your general knowledge of travel policies."
        );
      }
    },
    {
      name: "search_policy",
      description:
        "Search the internal policy knowledge base for documents about " +
        "booking rules, cancellation terms, payment conditions, child/pet policies, " +
        "accessibility requirements, data protection, or travel insurance requirements.",
      schema: z.object({
        question: z.string().describe("The policy question to search for"),
        limit: z
          .number()
          .optional()
          .default(4)
          .describe("Number of policy documents to retrieve"),
      }),
    }
  );

  /** Fetch policy documents by category. */
  const getPolicyByCategoryTool = tool(
    async ({ category }) => {
      console.log("[Policy Agent] get_policy_by_category:", category);

      const docs = await policyCollection
        .find(
          { "metadata.category": category },
          { projection: { _id: 0 } }
        )
        .toArray();

      if (!docs.length) {
        return `No policy documents found for category: ${category}.`;
      }
      return JSON.stringify(docs);
    },
    {
      name: "get_policy_by_category",
      description:
        "Retrieve all policy documents for a specific category.",
      schema: z.object({
        category: z
          .enum([
            "booking",
            "cancellation",
            "payment",
            "child_policy",
            "pet_policy",
            "accessibility",
            "data_protection",
            "travel_insurance",
          ])
          .describe("Policy category"),
      }),
    }
  );

  /** Check the cancellation terms for a specific booking. */
  const getCancellationTermsTool = tool(
    async ({ booking_ref }) => {
      console.log("[Policy Agent] get_cancellation_terms:", booking_ref);

      const booking = await bookingsCollection.findOne(
        { booking_ref: booking_ref.toUpperCase() },
        { projection: { _id: 0 } }
      );

      if (!booking) {
        return `No booking found with reference: ${booking_ref}. Cannot determine cancellation terms.`;
      }

      // Fetch relevant cancellation policy
      const policies = await vectorSearch(
        client,
        DB_NAMES.HOLIDAY,
        COLLECTIONS.POLICIES,
        VECTOR_INDEXES.POLICIES,
        `cancellation refund terms ${booking.booking_type ?? "hotel"} booking`,
        3
      );

      const checkInOrDeparture =
        booking.accommodation?.check_in ?? booking.transport?.departure ?? null;
      const daysUntilArrival = checkInOrDeparture
        ? Math.ceil(
            (new Date(checkInOrDeparture).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
          )
        : null;

      return JSON.stringify({
        booking_summary: {
          booking_ref: booking.booking_ref,
          type: booking.booking_type,
          status: booking.status,
          total_price: booking.price?.total_price,
          currency: booking.price?.currency,
          days_until_checkin_or_departure: daysUntilArrival,
        },
        relevant_policies: policies,
      });
    },
    {
      name: "get_cancellation_terms",
      description:
        "Look up the cancellation terms for a specific booking reference. " +
        "Returns the booking summary alongside relevant cancellation policy documents.",
      schema: z.object({
        booking_ref: z.string().describe("8-character booking reference"),
      }),
    }
  );

  /** Compliance check — validate a planned booking against policies. */
  const checkBookingComplianceTool = tool(
    async ({ booking_type, destination_country, num_children, has_pets, check_in, check_out }) => {
      console.log("[Policy Agent] check_booking_compliance:", booking_type, destination_country);

      const queries: string[] = [`${booking_type} booking policy`];
      if (num_children && num_children > 0) queries.push("child policy age restrictions");
      if (has_pets) queries.push("pet policy allowed breeds restrictions");
      if (destination_country) queries.push(`travel requirements ${destination_country}`);

      const allResults = await Promise.all(
        queries.map((q) =>
          vectorSearch(
            client,
            DB_NAMES.HOLIDAY,
            COLLECTIONS.POLICIES,
            VECTOR_INDEXES.POLICIES,
            q,
            2
          ).catch(() => [])
        )
      );

      const uniquePolicies = Array.from(
        new Map(
          allResults.flat().map((p) => [JSON.stringify(p), p])
        ).values()
      );

      const nights =
        check_in && check_out
          ? Math.ceil(
              (new Date(check_out).getTime() - new Date(check_in).getTime()) /
                (1000 * 60 * 60 * 24)
            )
          : null;

      return JSON.stringify({
        compliance_check: {
          booking_type,
          destination_country,
          num_children: num_children ?? 0,
          has_pets: has_pets ?? false,
          nights,
        },
        applicable_policies: uniquePolicies,
        recommendation:
          uniquePolicies.length
            ? "Review the applicable policies above before confirming."
            : "No specific policy restrictions found — standard terms apply.",
      });
    },
    {
      name: "check_booking_compliance",
      description:
        "Check whether a planned holiday booking complies with platform policies. " +
        "Validates against child policies, pet rules, destination requirements, and booking terms.",
      schema: z.object({
        booking_type: z.enum(["hotel", "transport", "package"]),
        destination_country: z.string().optional(),
        num_children: z.number().int().min(0).optional(),
        has_pets: z.boolean().optional(),
        check_in: z.string().optional().describe("ISO date"),
        check_out: z.string().optional().describe("ISO date"),
      }),
    }
  );

  const tools = [
    searchPolicyTool,
    getPolicyByCategoryTool,
    getCancellationTermsTool,
    checkBookingComplianceTool,
  ];
  const toolNode = new ToolNode<typeof PolicyState.State>(tools);

  // ─── Model ─────────────────────────────────────────────────────────────────

  const model = new ChatOpenAI({ model: "gpt-4o" }).bindTools(tools);

  // ─── Nodes ─────────────────────────────────────────────────────────────────

  async function callModel(state: typeof PolicyState.State) {
    console.log(`[Policy Agent] → agent node (messages: ${state.messages.length})`);
    const prompt = ChatPromptTemplate.fromMessages([
      [
        "system",
        `You are the Policy & Compliance Specialist. Your role is to answer 
questions about travel booking rules, cancellation terms, payment conditions, 
child and pet policies, accessibility requirements, data protection practices,
and travel insurance recommendations.

Search the policy knowledge base first. If no specific document is found, 
use your knowledge of standard travel industry practices, clearly stating 
when you are speaking generally rather than from a specific policy document.

When checking compliance for a planned booking, proactively flag any potential 
issues (e.g. pets not allowed, child age restrictions, mandatory insurance) before 
the booking is confirmed.

Always be precise: quote relevant policy clauses when available. For legally 
binding queries, direct travellers to the platform's customer support team.

User context from previous sessions:
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

  function shouldContinue(state: typeof PolicyState.State) {
    const last = state.messages[state.messages.length - 1] as AIMessage;
    const next = last.tool_calls?.length ? "tools" : "__end__";
    console.log(
      `[Policy Agent] → shouldContinue: ${next}${
        next === "tools" ? ` (${last.tool_calls!.map((tc) => tc.name).join(", ")})` : ""
      }`
    );
    return next;
  }

  // ─── Graph ─────────────────────────────────────────────────────────────────

  const workflow = new StateGraph(PolicyState)
    .addNode("agent", callModel)
    .addNode("tools", toolNode)
    .addEdge("__start__", "agent")
    .addConditionalEdges("agent", shouldContinue)
    .addEdge("tools", "agent");

  const checkpointer = new MongoDBSaver({ client, dbName: DB_NAMES.MEMORY });
  const app = workflow.compile({ checkpointer });

  const finalState = await app.invoke(
    { messages: [new HumanMessage(query)] },
    { recursionLimit: 15, configurable: { thread_id: `${threadId}_policy` } }
  );

  const responseContent =
    finalState.messages[finalState.messages.length - 1].content as string;

  await recordInteractionSummary(
    store,
    userId,
    "policy",
    `Query: "${query.slice(0, 120)}". Summary: "${responseContent.slice(0, 250)}"`
  );

  return responseContent;
}

/**
 * Express server – main entry point.
 *
 * Endpoints:
 *   POST /chat              – Start a new conversation (generates a threadId)
 *   POST /chat/:threadId    – Continue an existing conversation
 *   GET  /health            – Health check
 *   GET  /                  – Serves the frontend chat UI
 *
 * Both POST endpoints require:
 *   Body:  { "message": "...", "userId": "..." }
 *
 * The userId isolates long-term memories per user.
 */

import "dotenv/config";
import express, { Express, Request, Response, NextFunction } from "express";
import path from "path";
import { MongoClient } from "mongodb";
import { v4 as uuidv4 } from "uuid";
import { callOrchestrator } from "./orchestrator";
import { createStore } from "./memory/store";
import { Tracer, runWithTracer, type TraceStep } from "./shared/tracer";
import type { MongoDBStore } from "@langchain/langgraph-checkpoint-mongodb";

const app: Express = express();
app.use(express.json());

// ── MongoDB ────────────────────────────────────────────────────────────────────

const mongoClient = new MongoClient(process.env.MONGODB_URI as string);
let store: MongoDBStore;

// ─── Static frontend ──────────────────────────────────────────────────────────

app.use(express.static(path.join(process.cwd(), "frontend")));

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/**
 * Start a new conversation.
 * Returns the generated threadId so the client can continue the thread.
 */
app.post("/chat", async (req: Request, res: Response, next: NextFunction) => {
  const { message, userId } = req.body as {
    message?: string;
    userId?: string;
  };

  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }

  const threadId = uuidv4();
  console.log(`[POST /chat] userId=${userId} threadId=${threadId} message="${message.slice(0, 80)}"`)

  try {
    const result = await callOrchestrator(
      mongoClient,
      store,
      message,
      threadId,
      userId
    );
    res.json({ threadId, userId, response: result.response, agent: result.agent });
  } catch (err) {
    next(err);
  }
});

/**
 * Streaming chat — emits live execution-trace steps (NDJSON) as the request is
 * processed, then a final `{ type: "final", ... }` line with the answer.
 *
 * Used by the frontend to show the audience every vector search, MongoDB
 * operation, memory read/write and routing decision in real time.
 *
 * Line protocol (one JSON object per line):
 *   { "type": "step",  "step": TraceStep }
 *   { "type": "final", "threadId", "userId", "response", "agent" }
 *   { "type": "error", "error": "..." }
 */
async function handleStreamingChat(
  req: Request,
  res: Response,
  threadId: string,
  isNew: boolean
): Promise<void> {
  const { message, userId } = req.body as { message?: string; userId?: string };

  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable proxy buffering
  res.flushHeaders?.();

  const write = (obj: unknown) => {
    res.write(JSON.stringify(obj) + "\n");
    // @ts-expect-error flush exists when compression middleware is present
    res.flush?.();
  };

  const tracer = new Tracer((step: TraceStep) => write({ type: "step", step }));

  console.log(
    `[POST stream] userId=${userId} threadId=${threadId} message="${message.slice(0, 80)}"`
  );

  try {
    const result = await runWithTracer(tracer, () =>
      callOrchestrator(mongoClient, store, message, threadId, userId)
    );
    write({
      type: "final",
      threadId,
      userId,
      response: result.response,
      agent: result.agent,
    });
  } catch (err) {
    console.error("[Stream Error]", err);
    write({
      type: "error",
      error: err instanceof Error ? err.message : "Internal server error",
    });
  } finally {
    res.end();
  }
}

/** Start a new streamed conversation. */
app.post("/chat/stream", (req: Request, res: Response) => {
  void handleStreamingChat(req, res, uuidv4(), true);
});

/** Continue an existing streamed conversation by threadId. */
app.post("/chat/stream/:threadId", (req: Request, res: Response) => {
  void handleStreamingChat(req, res, req.params.threadId, false);
});

/**
 * Continue an existing conversation by threadId.
 * The MongoDBSaver checkpointer automatically restores conversation history.
 */
app.post(
  "/chat/:threadId",
  async (req: Request, res: Response, next: NextFunction) => {
    const { threadId } = req.params;
    const { message, userId } = req.body as {
      message?: string;
      userId?: string;
    };

    if (!message) {
      res.status(400).json({ error: "message is required" });
      return;
    }
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    console.log(`[POST /chat/:threadId] userId=${userId} threadId=${threadId} message="${message.slice(0, 80)}"`)

    try {
      const response = await callOrchestrator(
        mongoClient,
        store,
        message,
        threadId,
        userId
      );
      res.json({ threadId, userId, response: response.response, agent: response.agent });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Error handler ────────────────────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[Server Error]", err);
  res.status(500).json({ error: "Internal server error" });
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function startServer() {
  try {
    await mongoClient.connect();
    await mongoClient.db("admin").command({ ping: 1 });
    console.log("Connected to MongoDB successfully.");

    // Initialise the store once: creates the TTL index and wires up embeddings.
    store = await createStore(mongoClient);
    console.log("MongoDBStore initialised.");

    const PORT = process.env.PORT ?? 3000;
    app.listen(PORT, () => {
      console.log(`\nMongoDB Agentic AI Holiday Assistant running on port ${PORT}`);
      console.log(`  POST http://localhost:${PORT}/chat`);
      console.log(`  POST http://localhost:${PORT}/chat/:threadId`);
      console.log(`  GET  http://localhost:${PORT}/health\n`);
    });
  } catch (err) {
    console.error("Failed to connect to MongoDB:", err);
    process.exit(1);
  }
}

startServer();

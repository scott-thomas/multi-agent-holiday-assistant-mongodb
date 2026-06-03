/**
 * Execution Tracer
 *
 * Captures the step-by-step work a request performs (intent routing, vector
 * searches, MongoDB reads/writes, long-term memory operations, LLM calls) and
 * streams them to whoever is listening — typically the frontend, so a demo
 * audience can watch the agent "think" in real time.
 *
 * It uses Node's AsyncLocalStorage so the active tracer is ambient: any code
 * running inside `runWithTracer(...)` — including deeply nested LangGraph nodes
 * and tool calls — can emit steps without having a tracer threaded through its
 * function signature.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

// ─── Step shape ────────────────────────────────────────────────────────────────

export type StepPhase =
  | "orchestrator"
  | "memory"
  | "agent"
  | "tool"
  | "vector_search"
  | "mongodb"
  | "llm";

export type StepStatus = "running" | "done" | "error";

export interface TraceStep {
  id: string;
  ts: number;
  phase: StepPhase;
  title: string;
  detail?: string;
  /** MongoDB database, collection and index this step touches (when relevant). */
  db?: string;
  collection?: string;
  index?: string;
  /** Which specialist agent this step belongs to. */
  agent?: string;
  status: StepStatus;
  durationMs?: number;
  /** Arbitrary extra info (e.g. result counts, routing reasoning). */
  meta?: Record<string, unknown>;
}

export type StepInit = Omit<TraceStep, "id" | "ts" | "status"> & {
  status?: StepStatus;
};

// ─── Tracer ────────────────────────────────────────────────────────────────────

export class Tracer {
  constructor(private readonly sink: (step: TraceStep) => void) {}

  /** Emit a fully-formed step event. */
  emit(step: TraceStep): void {
    try {
      this.sink(step);
    } catch {
      /* never let a logging failure break the request */
    }
  }

  /** Emit a "running" step and return its id so it can later be completed. */
  start(init: StepInit): string {
    const id = randomUUID();
    this.emit({
      id,
      ts: Date.now(),
      status: "running",
      ...init,
    });
    return id;
  }

  /** Mark a previously-started step as done (or error), with a duration. */
  end(id: string, startTs: number, patch: Partial<TraceStep> = {}): void {
    this.emit({
      id,
      ts: Date.now(),
      phase: patch.phase ?? "mongodb",
      title: patch.title ?? "",
      status: patch.status ?? "done",
      durationMs: Date.now() - startTs,
      ...patch,
    });
  }
}

// ─── Ambient storage ───────────────────────────────────────────────────────────

const storage = new AsyncLocalStorage<Tracer>();

/** Run `fn` with `tracer` available to all nested async code via getTracer(). */
export function runWithTracer<T>(tracer: Tracer, fn: () => Promise<T>): Promise<T> {
  return storage.run(tracer, fn);
}

/** Get the tracer for the current async context, if any. */
export function getTracer(): Tracer | undefined {
  return storage.getStore();
}

// ─── Convenience helpers ───────────────────────────────────────────────────────

/** Emit a single instantaneous step (no running/done lifecycle). */
export function emitStep(init: StepInit): void {
  const tracer = getTracer();
  if (!tracer) return;
  tracer.emit({
    id: randomUUID(),
    ts: Date.now(),
    status: init.status ?? "done",
    ...init,
  });
}

/**
 * Wrap an async operation so it emits a "running" step before, and a
 * "done"/"error" step (with duration and any patched fields) after.
 *
 * `complete` lets the caller enrich the final step from the operation's result
 * (e.g. number of documents returned).
 */
export async function traceStep<T>(
  init: StepInit,
  fn: () => Promise<T>,
  complete?: (result: T) => Partial<TraceStep>
): Promise<T> {
  const tracer = getTracer();
  if (!tracer) return fn();

  const startTs = Date.now();
  const id = tracer.start(init);
  try {
    const result = await fn();
    tracer.end(id, startTs, {
      phase: init.phase,
      title: init.title,
      detail: init.detail,
      db: init.db,
      collection: init.collection,
      index: init.index,
      agent: init.agent,
      status: "done",
      ...(complete ? complete(result) : {}),
    });
    return result;
  } catch (err) {
    tracer.end(id, startTs, {
      phase: init.phase,
      title: init.title,
      db: init.db,
      collection: init.collection,
      index: init.index,
      agent: init.agent,
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** Process-local ExecutionStore implementation for run snapshots and lifecycle events. */
import type {
  AgentEventEnvelope,
  AgentRetry,
  AgentRunSnapshot,
  AgentRunState,
} from "@answra/shared/schema";
import { createExecutionEvent } from "./events";
import { applyExecutionEvent } from "./projection";
import { canTransitionRun, isTerminalRunState } from "./status";
import type { ExecutionRunStart, ExecutionStore } from "./store";

type ExecutionRecord = {
  snapshot: AgentRunSnapshot;
  conversationId: string;
  producerId: string;
  events: AgentEventEnvelope[];
};

export class MemoryExecutionStore implements ExecutionStore {
  private readonly runs = new Map<string, ExecutionRecord>();
  private readonly listeners = new Set<(event: AgentEventEnvelope) => void>();

  async startRun(input: ExecutionRunStart): Promise<void> {
    if (this.runs.has(input.runId)) throw new Error(`Execution run already exists: ${input.runId}`);
    const now = new Date().toISOString();
    const record: ExecutionRecord = {
      snapshot: {
        runId: input.runId,
        state: "queued",
        attempt: 1,
        generation: input.generation ?? 0,
        updatedAt: now,
      },
      conversationId: input.conversationId,
      producerId: input.producerId,
      events: [],
    };
    this.runs.set(input.runId, record);
    await this.append(record, {
      type: "run-state-changed",
      state: "queued",
      attempt: record.snapshot.attempt,
    });
    await this.transition(input.runId, "claimed");
  }

  async transition(runId: string, state: AgentRunState): Promise<void> {
    const record = this.requireRun(runId);
    this.assertTransition(record.snapshot.state, state);
    await this.append(record, {
      type: "run-state-changed",
      state,
      attempt: record.snapshot.attempt,
    });
  }

  async scheduleRetry(runId: string, retry: AgentRetry): Promise<void> {
    const record = this.requireRun(runId);
    this.assertTransition(record.snapshot.state, "retry-wait");
    await this.append(record, {
      type: "run-state-changed",
      state: "retry-wait",
      attempt: record.snapshot.attempt,
      retry: {
        kind: retry.kind,
        attempt: retry.attempt,
        maxRetries: retry.maxRetries,
        delayMs: retry.delayMs,
        scheduledAt: new Date().toISOString(),
      },
    });
  }

  async resumeRetry(runId: string): Promise<void> {
    const record = this.requireRun(runId);
    this.assertTransition(record.snapshot.state, "running");
    record.snapshot = { ...record.snapshot, attempt: record.snapshot.attempt + 1 };
    await this.append(record, {
      type: "run-state-changed",
      state: "running",
      attempt: record.snapshot.attempt,
    });
  }

  async finishRun(
    runId: string,
    state: Extract<AgentRunState, "completed" | "failed" | "aborted">,
  ): Promise<void> {
    const record = this.requireRun(runId);
    if (isTerminalRunState(record.snapshot.state)) return;
    this.assertTransition(record.snapshot.state, state);
    await this.append(record, {
      type: "run-state-changed",
      state,
      attempt: record.snapshot.attempt,
    });
  }

  async getRun(runId: string): Promise<AgentRunSnapshot | undefined> {
    const record = this.runs.get(runId);
    return record ? { ...record.snapshot } : undefined;
  }

  async readEvents(runId: string): Promise<AgentEventEnvelope[]> {
    return (this.runs.get(runId)?.events ?? []).map((event) => ({
      ...event,
      event: { ...event.event },
    }));
  }

  subscribe(listener: (event: AgentEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async append(
    record: ExecutionRecord,
    event: Extract<AgentEventEnvelope["event"], { type: "run-state-changed" }>,
  ): Promise<void> {
    const sequence = record.events.length + 1;
    const envelope = createExecutionEvent(
      {
        runId: record.snapshot.runId,
        attemptId: `${record.snapshot.runId}:attempt:${event.attempt}`,
        conversationId: record.conversationId,
        producerId: record.producerId,
        sequence,
        aggregateRevision: sequence,
        occurredAt: new Date().toISOString(),
      },
      event,
    );
    record.events.push(envelope);
    record.snapshot = applyExecutionEvent(record.snapshot, envelope);
    for (const listener of this.listeners) listener({ ...envelope, event: { ...envelope.event } });
  }

  private requireRun(runId: string): ExecutionRecord {
    const record = this.runs.get(runId);
    if (!record) throw new Error(`Execution run does not exist: ${runId}`);
    return record;
  }

  private assertTransition(from: AgentRunState, to: AgentRunState): void {
    if (!canTransitionRun(from, to))
      throw new Error(`Invalid execution transition: ${from} -> ${to}`);
  }
}

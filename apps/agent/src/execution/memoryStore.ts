/** 唯一的进程内 Agent 事件 store；状态缓存由追加的事件同步更新。 */
import type {
  AgentEvent,
  AgentEventEnvelope,
  AgentRetry,
  AgentRunSnapshot,
  AgentRunState,
} from "@answra/shared/schema";
import { createExecutionEvent } from "./events";
import { canTransitionRun, isTerminalRunState } from "./status";
import type { ExecutionEventMetadata, ExecutionRunStart, ExecutionStore } from "./store";

type ExecutionRecord = {
  snapshot: AgentRunSnapshot;
  conversationId: string;
  producerId: string;
  events: AgentEventEnvelope[];
};

export class MemoryExecutionStore implements ExecutionStore {
  private readonly runs = new Map<string, ExecutionRecord>();
  private readonly conversationRevisions = new Map<string, number>();
  private readonly listeners = new Set<(event: AgentEventEnvelope) => void>();

  async startRun(input: ExecutionRunStart): Promise<AgentEventEnvelope[]> {
    if (this.runs.has(input.runId)) throw new Error(`Execution run already exists: ${input.runId}`);
    const record: ExecutionRecord = {
      snapshot: {
        runId: input.runId,
        state: "queued",
        attempt: 1,
        generation: input.generation ?? 0,
        updatedAt: new Date().toISOString(),
      },
      conversationId: input.conversationId,
      producerId: input.producerId,
      events: [],
    };
    this.runs.set(input.runId, record);
    const queued = await this.appendEvent(input.runId, {
      type: "run-state-changed",
      state: "queued",
      attempt: record.snapshot.attempt,
    });
    const claimed = await this.transition(input.runId, "claimed");
    return [queued, claimed];
  }

  async transition(runId: string, state: AgentRunState): Promise<AgentEventEnvelope> {
    const record = this.requireRun(runId);
    return this.appendEvent(runId, {
      type: "run-state-changed",
      state,
      attempt: record.snapshot.attempt,
    });
  }

  async scheduleRetry(runId: string, retry: AgentRetry): Promise<AgentEventEnvelope> {
    const record = this.requireRun(runId);
    return this.appendEvent(runId, {
      type: "run-state-changed",
      state: "retry-wait",
      attempt: record.snapshot.attempt,
      retry: { ...retry, scheduledAt: new Date().toISOString() },
    });
  }

  async resumeRetry(runId: string): Promise<AgentEventEnvelope> {
    const record = this.requireRun(runId);
    return this.appendEvent(runId, {
      type: "run-state-changed",
      state: "running",
      attempt: record.snapshot.attempt + 1,
    });
  }

  async finishRun(
    runId: string,
    state: Extract<AgentRunState, "completed" | "failed" | "aborted">,
  ): Promise<AgentEventEnvelope | undefined> {
    const record = this.requireRun(runId);
    if (isTerminalRunState(record.snapshot.state)) return undefined;
    return this.appendEvent(runId, {
      type: "run-state-changed",
      state,
      attempt: record.snapshot.attempt,
    });
  }

  async appendEvent(
    runId: string,
    event: AgentEvent,
    metadata: ExecutionEventMetadata = {},
  ): Promise<AgentEventEnvelope> {
    const record = this.requireRun(runId);
    if (event.type === "run-state-changed") {
      if (
        event.state !== record.snapshot.state &&
        !canTransitionRun(record.snapshot.state, event.state)
      )
        throw new Error(`Invalid execution transition: ${record.snapshot.state} -> ${event.state}`);
    }
    const occurredAt = new Date().toISOString();
    const sequence = record.events.length + 1;
    const aggregateRevision = (this.conversationRevisions.get(record.conversationId) ?? 0) + 1;
    const envelope = createExecutionEvent(
      {
        runId,
        attemptId: `${runId}:attempt:${event.type === "run-state-changed" ? event.attempt : record.snapshot.attempt}`,
        conversationId: record.conversationId,
        ...(metadata.stepId === undefined ? {} : { stepId: metadata.stepId }),
        producerId: record.producerId,
        sequence,
        aggregateRevision,
        occurredAt,
      },
      event,
    );
    record.events.push(envelope);
    this.conversationRevisions.set(record.conversationId, aggregateRevision);
    if (event.type === "run-state-changed") {
      record.snapshot = {
        ...record.snapshot,
        state: event.state,
        attempt: event.attempt,
        updatedAt: occurredAt,
      };
    }
    for (const listener of this.listeners) listener(cloneEnvelope(envelope));
    return cloneEnvelope(envelope);
  }

  async getRun(runId: string): Promise<AgentRunSnapshot | undefined> {
    const record = this.runs.get(runId);
    return record ? { ...record.snapshot } : undefined;
  }

  async getConversationRevision(conversationId: string): Promise<number> {
    return this.conversationRevisions.get(conversationId) ?? 0;
  }

  async readEvents(conversationId: string, afterRevision: number): Promise<AgentEventEnvelope[]> {
    return [...this.runs.values()]
      .filter((record) => record.conversationId === conversationId)
      .flatMap((record) => record.events)
      .filter((event) => event.aggregateRevision > afterRevision)
      .sort((left, right) => left.aggregateRevision - right.aggregateRevision)
      .map(cloneEnvelope);
  }

  async readEventsForRun(runId: string): Promise<AgentEventEnvelope[]> {
    return (this.runs.get(runId)?.events ?? []).map(cloneEnvelope);
  }

  subscribe(listener: (event: AgentEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private requireRun(runId: string): ExecutionRecord {
    const record = this.runs.get(runId);
    if (!record) throw new Error(`Execution run does not exist: ${runId}`);
    return record;
  }
}

function cloneEnvelope(envelope: AgentEventEnvelope): AgentEventEnvelope {
  return { ...envelope, event: { ...envelope.event } };
}

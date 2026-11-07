/** Execution lifecycle repository port; the current adapter is process-local and replaceable. */
import type {
  AgentEvent,
  AgentEventEnvelope,
  AgentRetry,
  AgentRunSnapshot,
  AgentRunState,
} from "@answra/shared/schema";

export interface ExecutionRunStart {
  runId: string;
  conversationId: string;
  producerId: string;
  generation?: number;
}

export interface ExecutionEventMetadata {
  stepId?: string;
}

export interface ExecutionStore {
  startRun(input: ExecutionRunStart): Promise<void>;
  transition(runId: string, state: AgentRunState): Promise<void>;
  scheduleRetry(runId: string, retry: AgentRetry): Promise<void>;
  resumeRetry(runId: string): Promise<void>;
  finishRun(
    runId: string,
    state: Extract<AgentRunState, "completed" | "failed" | "aborted">,
  ): Promise<void>;
  appendEvent(
    runId: string,
    event: AgentEvent,
    metadata?: ExecutionEventMetadata,
  ): Promise<AgentEventEnvelope>;
  getRun(runId: string): Promise<AgentRunSnapshot | undefined>;
  getConversationRevision(conversationId: string): Promise<number>;
  readEvents(conversationId: string, afterRevision: number): Promise<AgentEventEnvelope[]>;
  readEventsForRun(runId: string): Promise<AgentEventEnvelope[]>;
  subscribe(listener: (event: AgentEventEnvelope) => void): () => void;
}

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
  startRun(input: ExecutionRunStart): Promise<AgentEventEnvelope[]>;
  transition(runId: string, state: AgentRunState): Promise<AgentEventEnvelope>;
  scheduleRetry(runId: string, retry: AgentRetry): Promise<AgentEventEnvelope>;
  resumeRetry(runId: string): Promise<AgentEventEnvelope>;
  finishRun(
    runId: string,
    state: Extract<AgentRunState, "completed" | "failed" | "aborted">,
  ): Promise<AgentEventEnvelope | undefined>;
  appendEvent(
    runId: string,
    event: AgentEvent,
    metadata?: ExecutionEventMetadata,
  ): Promise<AgentEventEnvelope>;
  getRun(runId: string): Promise<AgentRunSnapshot | undefined>;
  getConversationRevision(conversationId: string): Promise<number>;
  /** 用 transcript 的持久游标初始化事件 revision；只补齐计数器，不产生事件。 */
  seedConversationRevision(conversationId: string, revision: number): Promise<void>;
  /** 会话被清空时丢弃该会话的事件与 revision，让 UI 游标从零重新对齐。 */
  resetConversation(conversationId: string): Promise<void>;
  readEvents(conversationId: string, afterRevision: number): Promise<AgentEventEnvelope[]>;
  readEventsForRun(runId: string): Promise<AgentEventEnvelope[]>;
  subscribe(listener: (event: AgentEventEnvelope) => void): () => void;
}

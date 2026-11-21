/** SessionJournal 端口：只追加、按 sequence 读取；不推导业务状态。 */
import type { AgentEvent, SessionEventEnvelope } from "@answra/shared/schema";
import type { SessionId, StepId, TurnId } from "./contracts";

export interface SessionJournalAppend {
  turnId?: TurnId;
  messageId?: string;
  stepId?: StepId;
  operationId?: string;
  producerId?: string;
  occurredAt?: string;
  eventId?: string;
}

export interface SessionJournal {
  append(
    sessionId: SessionId,
    event: AgentEvent,
    metadata?: SessionJournalAppend,
  ): Promise<SessionEventEnvelope>;
  readAfter(sessionId: SessionId, sequence: number): Promise<SessionEventEnvelope[]>;
}

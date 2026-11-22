/** SessionJournal 端口：只追加、按 sequence 读取；不推导业务状态。 */
import type { AgentDurableEvent, SessionEventEnvelope } from "@answra/shared/schema";
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
    event: AgentDurableEvent,
    metadata?: SessionJournalAppend,
  ): Promise<SessionEventEnvelope>;
  readAfter(sessionId: SessionId, sequence: number): Promise<SessionEventEnvelope[]>;
  /** 会话已写入的最大 `seq`；没有事实时为 0。恢复时用它 seed 客户端游标。 */
  lastSequence(sessionId: SessionId): Promise<number>;
  /** 清空会话事实；与 transcript 清空同一语义，清空后 `seq` 从 1 重新开始。 */
  clear(sessionId: SessionId): Promise<void>;
  /** 持有文件句柄的实现在宿主退出时释放；内存实现无需提供。 */
  close?(): void;
}

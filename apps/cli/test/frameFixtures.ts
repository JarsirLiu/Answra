import {
  type AgentDurableEvent,
  type AgentLiveOnlyEvent,
  type LiveFrame,
  SESSION_FRAME_SCHEMA_VERSION,
  type SessionFrame,
} from "@answra/shared/schema";

export const TEST_SESSION_ID = "conversation-1";

const TEST_OCCURRED_AT = "2026-11-22T00:00:00.000Z";

export interface SessionFrameFields {
  sessionId?: string;
  turnId?: string;
  messageId?: string;
  stepId?: string;
  operationId?: string;
  occurredAt?: string;
}

/** 构造一条 durable 事实帧；测试只关心事件与路由字段。 */
export function sessionFrame(
  seq: number,
  event: AgentDurableEvent,
  fields: SessionFrameFields = {},
): SessionFrame {
  return {
    schemaVersion: SESSION_FRAME_SCHEMA_VERSION,
    sessionId: fields.sessionId ?? TEST_SESSION_ID,
    seq,
    eventId: `event-${seq}`,
    occurredAt: fields.occurredAt ?? TEST_OCCURRED_AT,
    producerId: "test",
    ...(fields.turnId === undefined ? {} : { turnId: fields.turnId }),
    ...(fields.messageId === undefined ? {} : { messageId: fields.messageId }),
    ...(fields.stepId === undefined ? {} : { stepId: fields.stepId }),
    ...(fields.operationId === undefined ? {} : { operationId: fields.operationId }),
    event,
  };
}

/** 构造一条 live 增量帧；只承载高频 delta，没有序号。 */
export function liveFrame(
  event: AgentLiveOnlyEvent,
  fields: { sessionId?: string; messageId: string; stepId?: string },
): LiveFrame {
  return {
    sessionId: fields.sessionId ?? TEST_SESSION_ID,
    messageId: fields.messageId,
    ...(fields.stepId === undefined ? {} : { stepId: fields.stepId }),
    event,
  };
}

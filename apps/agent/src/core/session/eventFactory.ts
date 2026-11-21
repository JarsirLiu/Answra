/** 生成 SessionJournal 的目标 envelope；不决定事件语义，也不写投影。 */
import { randomUUID } from "node:crypto";
import type { AgentEvent, SessionEventEnvelope } from "@answra/shared/schema";
import type { SessionId, StepId, TurnId } from "./contracts";

const DEFAULT_PRODUCER_ID = "answra-agent";

export interface SessionEventContext {
  sessionId: SessionId;
  sequence: number;
  turnId?: TurnId;
  messageId?: string;
  stepId?: StepId;
  operationId?: string;
  producerId?: string;
  occurredAt?: string;
  eventId?: string;
}

export function createSessionEvent(
  context: SessionEventContext,
  event: AgentEvent,
): SessionEventEnvelope {
  if (!Number.isInteger(context.sequence) || context.sequence < 1) {
    throw new Error("Session event sequence 必须是正整数");
  }
  return {
    schemaVersion: 1,
    eventId: context.eventId ?? randomUUID(),
    sessionId: context.sessionId,
    ...(context.turnId === undefined ? {} : { turnId: context.turnId }),
    ...(context.messageId === undefined ? {} : { messageId: context.messageId }),
    ...(context.stepId === undefined ? {} : { stepId: context.stepId }),
    ...(context.operationId === undefined ? {} : { operationId: context.operationId }),
    sequence: context.sequence,
    producerId: context.producerId ?? DEFAULT_PRODUCER_ID,
    occurredAt: context.occurredAt ?? new Date().toISOString(),
    event,
  };
}

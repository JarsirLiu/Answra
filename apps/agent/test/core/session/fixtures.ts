import type {
  AgentDurableEvent,
  ConversationMessage,
  SessionEventEnvelope,
} from "@answra/shared/schema";
import {
  type StepId,
  sessionId,
  stepId,
  type TurnId,
  type TurnRunContext,
  turnId,
} from "../../../src/core/session/contracts";
import { createSessionEvent } from "../../../src/core/session/eventFactory";

export const TEST_SESSION_ID = sessionId("session-1");
export const TEST_TURN_ID = turnId("turn-1");
export const TEST_TURN_ID_2 = turnId("turn-2");
export const TEST_STEP_ID = stepId("step-1");
export const TEST_ACCESS_TOKEN = "test-access-token";

export const TEST_TURN_RUNTIME: TurnRunContext = {
  getAccessToken: async () => TEST_ACCESS_TOKEN,
};

export function userMessage(id = "message-1", text = "hello"): ConversationMessage {
  return {
    id,
    role: "user",
    text,
    images: [],
    status: "complete",
  };
}

export function sessionEvent(
  sequence: number,
  event: AgentDurableEvent,
  options: {
    turnId?: TurnId;
    messageId?: string;
    stepId?: StepId;
    operationId?: string;
  } = {},
): SessionEventEnvelope {
  return createSessionEvent(
    {
      sessionId: TEST_SESSION_ID,
      sequence,
      occurredAt: "2026-11-21T00:00:00.000Z",
      ...options,
    },
    event,
  );
}

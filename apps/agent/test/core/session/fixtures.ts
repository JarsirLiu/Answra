import type { ConversationMessage } from "@answra/shared";
import type { SessionItem } from "@answra/shared/schema";
import {
  type SessionId,
  type StepId,
  sessionId,
  stepId,
  type TurnId,
  type TurnRunContext,
  turnId,
} from "../../../src/core/session/contracts";
import type { SessionItemStore } from "../../../src/core/transcript/itemStore";
import { MemorySessionItemStore } from "../../../src/core/transcript/memoryItemStore";
import { MemoryConversationStore } from "../../../src/core/transcript/memoryStore";

export const TEST_SESSION_ID = sessionId("session-1");
export const TEST_TURN_ID = turnId("turn-1");
export const TEST_TURN_ID_2 = turnId("turn-2");
export const TEST_STEP_ID = stepId("step-1");
export const TEST_ACCESS_TOKEN = "test-access-token";
export const TEST_AT = "2026-11-23T10:00:00.000Z";

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
    parts: [],
  };
}

/** 测试用会话底座：内存 transcript + 内存条目，两者共享同一个会话 ID。 */
export async function createSessionFixture(
  options: {
    metadata?: { scope: "conversation" | "coding" | "interview" | "answer"; title?: string };
  } = {},
): Promise<{ store: MemoryConversationStore; items: SessionItemStore }> {
  const store = new MemoryConversationStore();
  const items = new MemorySessionItemStore();
  await store.create(
    TEST_SESSION_ID,
    { activeAgentId: "general", participantAgentIds: ["general", "intake"] },
    {
      scope: options.metadata?.scope ?? "conversation",
      ...(options.metadata?.title === undefined ? {} : { title: options.metadata.title }),
    },
  );
  await items.create(TEST_SESSION_ID);
  return { store, items };
}

export function itemOf(
  seq: number,
  partial: Partial<SessionItem> & Pick<SessionItem, "itemId" | "payload">,
): SessionItem {
  return {
    seq,
    status: "complete",
    createdAt: TEST_AT,
    ...partial,
  } as SessionItem;
}

export type { SessionId, StepId, TurnId };

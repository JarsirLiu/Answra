import type { SessionFrame, SessionItem } from "@answra/shared/schema";
import { SESSION_FRAME_SCHEMA_VERSION } from "@answra/shared/schema";
import { describe, expect, it } from "vitest";
import {
  applyConversationSnapshot,
  type ConversationView,
  EMPTY_CONVERSATION_VIEW,
  foldConversationFrame,
} from "../src/app/conversationView";

const AT = "2026-11-23T10:00:00.000Z";
const SESSION = "conversation-1";
const TURN = "turn-1";

/** 快照里已含这条 assistant 消息的内存半截，条目帧随后给出完整版本。 */
function viewWithHalf(): ConversationView {
  return applyConversationSnapshot(EMPTY_CONVERSATION_VIEW, {
    conversationId: SESSION,
    lastSeq: 3,
    activeTurnId: TURN,
    activeMessageId: "m-a1",
    messages: [
      { id: "m-u1", role: "user", text: "写一个函数", images: [], status: "complete", parts: [] },
      {
        id: "m-a1",
        role: "assistant",
        text: "先写一半",
        images: [],
        status: "streaming",
        parts: [{ id: "t-1", kind: "text", text: "先写一半", state: "streaming" }],
      },
    ],
  });
}

describe("session item frames", () => {
  it("replaces the half-written part instead of appending a second one", () => {
    const view = viewWithHalf();
    const next = foldConversationFrame(
      view,
      itemFrame(4, textItem("t-1", "m-a1", "先写一半，再补完。")),
    );

    expect(next.lastSeq).toBe(4);
    expect(next.messages).toHaveLength(2);
    expect(next.messages[1]).toMatchObject({
      id: "m-a1",
      text: "先写一半，再补完。",
      parts: [{ id: "t-1", kind: "text", text: "先写一半，再补完。", state: "completed" }],
    });
  });

  it("joins multiple settled parts without a separator", () => {
    const view = foldConversationFrame(viewWithHalf(), itemFrame(4, textItem("t-1", "m-a1", "甲")));
    const next = foldConversationFrame(view, itemFrame(5, textItem("t-2", "m-a1", "乙")));

    expect(next.messages[1]?.text).toBe("甲乙");
    expect(next.messages[1]?.parts).toHaveLength(2);
  });

  it("adds a tool call and settles it from the result", () => {
    const withCall = foldConversationFrame(
      viewWithHalf(),
      itemFrame(4, toolCallItem("c-1", "m-a1", "read")),
    );
    expect(withCall.messages[1]?.parts?.[1]).toMatchObject({
      kind: "tool",
      toolCallId: "c-1",
      toolName: "read",
      state: "running",
    });

    const withResult = foldConversationFrame(
      withCall,
      itemFrame(5, toolResultItem("c-1", "m-a1", "output")),
    );
    expect(withResult.messages[1]?.parts?.[1]).toMatchObject({
      toolCallId: "c-1",
      state: "completed",
      output: { preview: "ok" },
    });
    expect(withResult.messages[1]?.parts).toHaveLength(2);
  });

  it("settles the turn and its unresolved tools on turn-end", () => {
    const withCall = foldConversationFrame(
      viewWithHalf(),
      itemFrame(4, toolCallItem("c-1", "m-a1", "shell")),
    );
    const next = foldConversationFrame(withCall, itemFrame(5, turnEndItem(TURN, "failed")));

    expect(next.messages[1]?.status).toBe("failed");
    expect(next.messages[1]?.parts?.[1]).toMatchObject({ state: "failed" });
    expect(next.activeTurnId).toBeUndefined();
    expect(next.activeMessageId).toBeUndefined();
  });

  it("marks a turn-end on a complete turn as an interrupted tool", () => {
    const withCall = foldConversationFrame(
      viewWithHalf(),
      itemFrame(4, toolCallItem("c-1", "m-a1", "shell")),
    );
    const next = foldConversationFrame(withCall, itemFrame(5, turnEndItem(TURN, "complete")));

    expect(next.messages[1]?.status).toBe("complete");
    expect(next.messages[1]?.parts?.[1]).toMatchObject({ state: "interrupted" });
  });

  it("does not duplicate a user message that the snapshot already has", () => {
    const view = viewWithHalf();
    const next = foldConversationFrame(view, itemFrame(4, userItem("m-u1", "写一个函数")));

    expect(next.messages.filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("appends a user message that is not in the snapshot yet", () => {
    const next = foldConversationFrame(
      EMPTY_CONVERSATION_VIEW,
      itemFrame(1, userItem("m-u2", "继续")),
    );

    expect(next.messages).toEqual([
      { id: "m-u2", role: "user", text: "继续", images: [], status: "complete", parts: [] },
    ]);
  });

  it("is idempotent when the same item arrives twice", () => {
    const once = foldConversationFrame(
      viewWithHalf(),
      itemFrame(4, textItem("t-1", "m-a1", "完整正文")),
    );
    const twice = foldConversationFrame(once, itemFrame(4, textItem("t-1", "m-a1", "完整正文")));

    expect(twice).toBe(once);
  });

  it("drops a tool result whose call never arrived", () => {
    const view = viewWithHalf();
    const next = foldConversationFrame(
      view,
      itemFrame(4, toolResultItem("missing", "m-a1", "output")),
    );

    expect(next.messages[1]?.parts).toEqual(view.messages[1]?.parts);
  });
});

function itemFrame(seq: number, item: Omit<SessionItem, "seq">): SessionFrame {
  return {
    schemaVersion: SESSION_FRAME_SCHEMA_VERSION,
    sessionId: SESSION,
    seq,
    eventId: `event-${seq}`,
    occurredAt: AT,
    producerId: "test",
    event: { type: "session-item", item: { ...item, seq } },
  };
}

function textItem(itemId: string, messageId: string, text: string): Omit<SessionItem, "seq"> {
  return {
    itemId,
    status: "complete",
    createdAt: AT,
    turnId: TURN,
    messageId,
    payload: { kind: "text", text },
  };
}

function userItem(itemId: string, text: string): Omit<SessionItem, "seq"> {
  return {
    itemId,
    status: "complete",
    createdAt: AT,
    turnId: TURN,
    payload: { kind: "user", text, images: [] },
  };
}

function toolCallItem(
  itemId: string,
  messageId: string,
  toolName: string,
): Omit<SessionItem, "seq"> {
  return {
    itemId,
    status: "complete",
    createdAt: AT,
    turnId: TURN,
    messageId,
    payload: { kind: "tool-call", toolCallId: itemId, toolName, input: { path: "a.ts" } },
  };
}

function toolResultItem(
  toolCallId: string,
  messageId: string,
  outcome: "output" | "error" | "denied",
): Omit<SessionItem, "seq"> {
  return {
    itemId: `${toolCallId}:result`,
    status: "complete",
    createdAt: AT,
    turnId: TURN,
    messageId,
    payload: {
      kind: "tool-result",
      toolCallId,
      outcome,
      ...(outcome === "output" ? { output: { preview: "ok" } } : {}),
    },
  };
}

function turnEndItem(
  turnId: string,
  status: "complete" | "failed" | "interrupted",
): Omit<SessionItem, "seq"> {
  return {
    itemId: `${turnId}:end`,
    status,
    createdAt: AT,
    turnId,
    payload: { kind: "turn-end", stepCount: 1, toolCalls: 1 },
  };
}

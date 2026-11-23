import { describe, expect, it } from "vitest";
import {
  type SessionItem,
  type SessionItemInterruption,
  sessionItemSchema,
  toolResultItemId,
  turnEndItemId,
} from "../src/schema";
import { foldSessionItems } from "../src/schema/session/fold";

const AT = "2026-11-23T10:00:00.000Z";
const TURN = "turn-1";
const MESSAGE = "message-1";

function item(overrides: Partial<SessionItem> & { seq: number }): SessionItem {
  return sessionItemSchema.parse({
    itemId: `item-${overrides.seq}`,
    status: "complete",
    createdAt: AT,
    turnId: TURN,
    messageId: MESSAGE,
    payload: { kind: "text", text: "" },
    ...overrides,
  });
}

function userItem(seq: number, id: string, text: string): SessionItem {
  return item({
    seq,
    itemId: id,
    messageId: undefined,
    payload: { kind: "user", text, images: [] },
  });
}

function textItem(seq: number, partId: string, text: string): SessionItem {
  return item({ seq, itemId: partId, payload: { kind: "text", text } });
}

function turnEnd(
  seq: number,
  status: SessionItem["status"],
  interruption?: SessionItemInterruption,
): SessionItem {
  return item({
    seq,
    itemId: turnEndItemId(TURN),
    status,
    messageId: undefined,
    payload: {
      kind: "turn-end",
      stepCount: 1,
      toolCalls: 0,
      ...(interruption === undefined ? {} : { interruption }),
    },
  });
}

describe("foldSessionItems", () => {
  it("folds a finished turn into a user message and an assistant message", () => {
    const messages = foldSessionItems([
      userItem(1, "user-1", "帮我看下"),
      textItem(2, "text-1", "我先"),
      item({
        seq: 3,
        itemId: "tool-1",
        payload: {
          kind: "tool-call",
          toolCallId: "tool-1",
          toolName: "read",
          input: { path: "a" },
        },
      }),
      item({
        seq: 4,
        itemId: toolResultItemId("tool-1"),
        payload: { kind: "tool-result", toolCallId: "tool-1", outcome: "output", output: "ok" },
      }),
      textItem(5, "text-2", "完成"),
      turnEnd(6, "complete"),
    ]);

    expect(messages).toEqual([
      {
        id: "user-1",
        role: "user",
        audience: { kind: "user" },
        text: "帮我看下",
        images: [],
        status: "complete",
        parts: [],
      },
      {
        id: MESSAGE,
        role: "assistant",
        audience: { kind: "user" },
        text: "我先完成",
        images: [],
        status: "complete",
        parts: [
          { id: "text-1", kind: "text", text: "我先", state: "completed" },
          {
            id: "tool-1",
            kind: "tool",
            toolCallId: "tool-1",
            toolName: "read",
            input: { path: "a" },
            state: "completed",
            output: "ok",
          },
          { id: "text-2", kind: "text", text: "完成", state: "completed" },
        ],
      },
    ]);
  });

  it("keeps the last message of an open turn streaming and its tool call running", () => {
    const messages = foldSessionItems(
      [
        textItem(1, "text-1", "正在查"),
        item({
          seq: 2,
          itemId: "tool-1",
          payload: { kind: "tool-call", toolCallId: "tool-1", toolName: "read" },
        }),
      ],
      { openTurnId: TURN },
    );

    expect(messages[0]?.status).toBe("streaming");
    expect(messages[0]?.parts?.at(-1)).toMatchObject({ kind: "tool", state: "running" });
  });

  it("settles an unterminated turn as interrupted once the session is reopened", () => {
    const messages = foldSessionItems([
      textItem(1, "text-1", "正在查"),
      item({
        seq: 2,
        itemId: "tool-1",
        payload: { kind: "tool-call", toolCallId: "tool-1", toolName: "read" },
      }),
    ]);

    expect(messages[0]?.status).toBe("interrupted");
    expect(messages[0]?.parts?.at(-1)).toMatchObject({ kind: "tool", state: "interrupted" });
  });

  it("derives a failed tool call from the turn outcome", () => {
    const messages = foldSessionItems([
      item({
        seq: 1,
        itemId: "tool-1",
        payload: { kind: "tool-call", toolCallId: "tool-1", toolName: "read" },
      }),
      turnEnd(2, "failed"),
    ]);

    expect(messages[0]?.status).toBe("failed");
    expect(messages[0]?.parts?.[0]).toMatchObject({ kind: "tool", state: "failed" });
  });

  it("does not let an open pointer resurrect a finished turn", () => {
    const messages = foldSessionItems([textItem(1, "text-1", "好"), turnEnd(2, "complete")], {
      openTurnId: TURN,
    });

    expect(messages[0]?.status).toBe("complete");
  });

  it("keeps earlier messages of a turn complete when a later one fails", () => {
    const messages = foldSessionItems([
      item({
        seq: 1,
        itemId: "text-1",
        messageId: "message-1",
        authorAgentId: "bot-a",
        audienceAgentId: "bot-b",
        payload: { kind: "text", text: "交给 bot-b" },
      }),
      item({
        seq: 2,
        itemId: "text-2",
        messageId: "message-2",
        authorAgentId: "bot-b",
        payload: { kind: "text", text: "收到" },
      }),
      turnEnd(3, "failed"),
    ]);

    expect(messages[0]).toMatchObject({
      id: "message-1",
      authorAgentId: "bot-a",
      audience: { kind: "bot", agentId: "bot-b" },
      status: "complete",
    });
    expect(messages[1]).toMatchObject({
      id: "message-2",
      authorAgentId: "bot-b",
      status: "failed",
    });
  });

  it("orders messages by first seq and parts by their own seq", () => {
    const messages = foldSessionItems([
      turnEnd(4, "complete"),
      textItem(3, "text-2", "世界"),
      userItem(1, "user-1", "你好"),
      textItem(2, "text-1", "你好，"),
    ]);

    expect(messages.map((message) => message.id)).toEqual(["user-1", MESSAGE]);
    expect(messages[1]?.text).toBe("你好，世界");
  });

  it("joins reasoning parts without a separator and only sets reasoning when present", () => {
    const messages = foldSessionItems([
      item({ seq: 1, itemId: "reason-1", payload: { kind: "reasoning", text: "先看" } }),
      item({ seq: 2, itemId: "reason-2", payload: { kind: "reasoning", text: "再答" } }),
      textItem(3, "text-1", "答"),
      turnEnd(4, "complete"),
    ]);

    expect(messages[0]?.reasoning).toBe("先看再答");
    const [withoutReasoning] = foldSessionItems([textItem(1, "text-1", "答")]);
    expect(withoutReasoning?.reasoning).toBeUndefined();
  });

  it("fails closed when a tool result has no matching call", () => {
    expect(() =>
      foldSessionItems([
        item({
          seq: 1,
          itemId: toolResultItemId("tool-1"),
          payload: { kind: "tool-result", toolCallId: "tool-1", outcome: "output", output: "ok" },
        }),
      ]),
    ).toThrow(/tool-result 没有对应的 tool-call/);
  });

  it("drops a turn that only produced a turn-end", () => {
    expect(foldSessionItems([turnEnd(1, "complete")])).toEqual([]);
  });
});

describe("sessionItemSchema", () => {
  const valid = {
    seq: 1,
    itemId: "text-1",
    status: "complete",
    createdAt: AT,
    turnId: TURN,
    messageId: MESSAGE,
    payload: { kind: "text", text: "hi" },
  };

  it("accepts a settled part item and is stable through JSON", () => {
    const parsed = sessionItemSchema.parse(valid);
    expect(sessionItemSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("accepts a turn-end with a turn finish reason and rejects an unknown one", () => {
    const turnEnd = {
      ...valid,
      itemId: turnEndItemId(TURN),
      messageId: undefined,
      payload: { kind: "turn-end", reason: "cancelled", stepCount: 1, toolCalls: 0 },
    };
    expect(sessionItemSchema.safeParse(turnEnd).success).toBe(true);
    expect(
      sessionItemSchema.safeParse({
        ...turnEnd,
        payload: { ...turnEnd.payload, reason: "not-a-reason" },
      }).success,
    ).toBe(false);
  });

  it("rejects a turn-end without a turn id", () => {
    expect(
      sessionItemSchema.safeParse({
        ...valid,
        itemId: turnEndItemId(TURN),
        turnId: undefined,
        messageId: undefined,
        payload: { kind: "turn-end", stepCount: 1, toolCalls: 0 },
      }).success,
    ).toBe(false);
  });

  it("rejects a part item without a message id", () => {
    expect(sessionItemSchema.safeParse({ ...valid, messageId: undefined }).success).toBe(false);
  });

  it("rejects a turn-end that points at a message", () => {
    expect(
      sessionItemSchema.safeParse({
        ...valid,
        itemId: turnEndItemId(TURN),
        payload: { kind: "turn-end", stepCount: 1, toolCalls: 0 },
      }).success,
    ).toBe(false);
  });

  it("rejects an interrupted turn-end without a reason", () => {
    expect(
      sessionItemSchema.safeParse({
        ...valid,
        status: "interrupted",
        itemId: turnEndItemId(TURN),
        messageId: undefined,
        payload: { kind: "turn-end", stepCount: 1, toolCalls: 0 },
      }).success,
    ).toBe(false);
  });

  it("rejects a tool item that claims a non-terminal result", () => {
    expect(
      sessionItemSchema.safeParse({
        ...valid,
        status: "failed",
        itemId: "tool-1",
        payload: { kind: "tool-call", toolCallId: "tool-1", toolName: "read" },
      }).success,
    ).toBe(false);
    expect(
      sessionItemSchema.safeParse({
        ...valid,
        status: "interrupted",
        itemId: toolResultItemId("tool-1"),
        payload: {
          kind: "tool-result",
          toolCallId: "tool-1",
          outcome: "error",
          errorText: "boom",
        },
      }).success,
    ).toBe(false);
  });

  it("rejects a user item with an author or a non-complete status", () => {
    const userPayload = { kind: "user", text: "hi", images: [] };
    expect(
      sessionItemSchema.safeParse({
        ...valid,
        itemId: "user-1",
        messageId: undefined,
        authorAgentId: "bot-a",
        payload: userPayload,
      }).success,
    ).toBe(false);
    expect(
      sessionItemSchema.safeParse({
        ...valid,
        itemId: "user-1",
        messageId: undefined,
        status: "interrupted",
        payload: userPayload,
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(
      sessionItemSchema.safeParse({ ...valid, payload: { kind: "job", text: "" } }).success,
    ).toBe(false);
  });

  it("derives distinct ids for a call, its result and the turn end", () => {
    expect(toolResultItemId("tool-1")).not.toBe("tool-1");
    expect(turnEndItemId(TURN)).not.toBe(TURN);
    expect(new Set(["tool-1", toolResultItemId("tool-1"), turnEndItemId(TURN)]).size).toBe(3);
  });
});

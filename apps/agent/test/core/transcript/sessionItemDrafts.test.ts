import type { ConversationMessage, ConversationMessagePart } from "@answra/shared";
import { describe, expect, it } from "vitest";
import type { SessionItemDraft } from "../../../src/core/transcript/itemStore";
import {
  handoffItemDraft,
  type ItemDraftContext,
  streamItemDrafts,
  unsettledItemDrafts,
  userItemDraft,
} from "../../../src/core/transcript/sessionItemDrafts";

const AT = "2026-11-23T10:00:00.000Z";
const TURN = "turn-1";
const MESSAGE = "m-a1";

const context: ItemDraftContext = {
  turnId: TURN,
  messageId: MESSAGE,
  authorAgentId: "general",
  createdAt: AT,
};

function assistant(parts: ConversationMessagePart[]): ConversationMessage {
  return {
    id: MESSAGE,
    role: "assistant",
    authorAgentId: "general",
    audience: { kind: "user" },
    text: "",
    images: [],
    status: "streaming",
    parts,
  };
}

function textPart(
  state: "streaming" | "completed" | "failed" | "interrupted",
): ConversationMessagePart {
  return { id: "p-text", kind: "text", text: "已经生成的正文", state };
}

function toolPart(overrides: Partial<Extract<ConversationMessagePart, { kind: "tool" }>> = {}) {
  return {
    id: "call-1",
    kind: "tool" as const,
    toolCallId: "call-1",
    toolName: "read_file",
    title: "读取文件",
    inputText: '{"path":"AGENTS.md"}',
    state: "running" as const,
    ...overrides,
  };
}

function existing(...ids: string[]): (itemId: string) => boolean {
  const set = new Set(ids);
  return (itemId) => set.has(itemId);
}

function payloadOf(draft: SessionItemDraft) {
  return draft.payload;
}

describe("userItemDraft", () => {
  it("uses the message id as the item id and drops message/author columns", () => {
    const message: ConversationMessage = {
      id: "m-u1",
      role: "user",
      audience: { kind: "user" },
      text: "写一个函数",
      images: [{ name: "shot.png", dataUrl: "data:image/png;base64,AA" }],
      status: "complete",
      parts: [],
    };

    const draft = userItemDraft(message, TURN, AT);

    expect(draft).toEqual({
      itemId: "m-u1",
      status: "complete",
      createdAt: AT,
      turnId: TURN,
      payload: {
        kind: "user",
        text: "写一个函数",
        images: [{ name: "shot.png", dataUrl: "data:image/png;base64,AA" }],
      },
    });
    expect(draft.messageId).toBeUndefined();
    expect(draft.authorAgentId).toBeUndefined();
  });

  it("rejects a non-user message", () => {
    expect(() => userItemDraft(assistant([]), TURN, AT)).toThrow(/用户消息/);
  });
});

describe("streamItemDrafts", () => {
  it("settles a text part with the full text held in memory", () => {
    const drafts = streamItemDrafts(
      assistant([textPart("completed")]),
      { type: "text-end", partId: "p-text" },
      context,
      existing(),
    );

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      itemId: "p-text",
      status: "complete",
      turnId: TURN,
      messageId: MESSAGE,
      authorAgentId: "general",
      payload: { kind: "text", text: "已经生成的正文" },
    });
  });

  it("keeps the part state when the text never completed", () => {
    const drafts = streamItemDrafts(
      assistant([textPart("streaming")]),
      { type: "text-end", partId: "p-text" },
      context,
      existing(),
    );

    expect(drafts[0]?.status).toBe("interrupted");
  });

  it("settles reasoning parts the same way", () => {
    const message = assistant([
      { id: "p-think", kind: "reasoning", text: "先读文件", state: "completed" },
    ]);

    const drafts = streamItemDrafts(
      message,
      { type: "reasoning-end", partId: "p-think" },
      context,
      existing(),
    );

    expect(drafts[0]).toMatchObject({
      itemId: "p-think",
      payload: { kind: "reasoning", text: "先读文件" },
    });
  });

  it("ignores an end event whose part is not in memory", () => {
    expect(
      streamItemDrafts(
        assistant([]),
        { type: "text-end", partId: "p-missing" },
        context,
        existing(),
      ),
    ).toEqual([]);
  });

  it("writes the tool call with its rendered title and input text", () => {
    const drafts = streamItemDrafts(
      assistant([toolPart()]),
      { type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: { path: "a.md" } },
      context,
      existing(),
    );

    expect(drafts).toEqual([
      {
        itemId: "call-1",
        status: "complete",
        createdAt: AT,
        turnId: TURN,
        messageId: MESSAGE,
        authorAgentId: "general",
        payload: {
          kind: "tool-call",
          toolCallId: "call-1",
          toolName: "read_file",
          title: "读取文件",
          inputText: '{"path":"AGENTS.md"}',
          input: { path: "a.md" },
        },
      },
    ]);
  });

  it("maps a successful executor result to the tool-result item", () => {
    const drafts = streamItemDrafts(
      assistant([toolPart()]),
      {
        type: "tool-execution-finished",
        toolCallId: "call-1",
        toolName: "read_file",
        input: {},
        result: { success: true, output: "文件内容" },
        durationMs: 42,
      },
      context,
      existing("call-1"),
    );

    expect(drafts).toEqual([
      {
        itemId: "call-1:result",
        status: "complete",
        createdAt: AT,
        turnId: TURN,
        messageId: MESSAGE,
        authorAgentId: "general",
        payload: {
          kind: "tool-result",
          toolCallId: "call-1",
          outcome: "output",
          output: "文件内容",
          durationMs: 42,
        },
      },
    ]);
  });

  it("maps a failed executor result to outcome error", () => {
    const drafts = streamItemDrafts(
      assistant([toolPart()]),
      {
        type: "tool-execution-finished",
        toolCallId: "call-1",
        toolName: "read_file",
        input: {},
        result: { success: false, errorText: "文件不存在" },
        durationMs: 12,
      },
      context,
      existing("call-1"),
    );

    expect(payloadOf(drafts[0] as SessionItemDraft)).toEqual({
      kind: "tool-result",
      toolCallId: "call-1",
      outcome: "error",
      errorText: "文件不存在",
      durationMs: 12,
    });
  });

  it("maps tool-result, tool-error and tool-output-denied to distinct outcomes", () => {
    const output = streamItemDrafts(
      assistant([toolPart()]),
      { type: "tool-result", toolCallId: "call-1", output: { ok: true } },
      context,
      existing("call-1"),
    );
    const error = streamItemDrafts(
      assistant([toolPart()]),
      { type: "tool-error", toolCallId: "call-1", errorText: "超时" },
      context,
      existing("call-1"),
    );
    const denied = streamItemDrafts(
      assistant([toolPart()]),
      { type: "tool-output-denied", toolCallId: "call-1", toolName: "read_file" },
      context,
      existing("call-1"),
    );

    expect(payloadOf(output[0] as SessionItemDraft)).toMatchObject({ outcome: "output" });
    expect(payloadOf(error[0] as SessionItemDraft)).toMatchObject({
      outcome: "error",
      errorText: "超时",
    });
    expect(payloadOf(denied[0] as SessionItemDraft)).toMatchObject({
      outcome: "denied",
    });
    expect(output[0]?.itemId).toBe(error[0]?.itemId);
    expect(error[0]?.itemId).toBe(denied[0]?.itemId);
  });

  it("drops a result whose tool call was never written", () => {
    expect(
      streamItemDrafts(
        assistant([toolPart()]),
        { type: "tool-result", toolCallId: "call-1", output: "x" },
        context,
        existing(),
      ),
    ).toEqual([]);
  });
});

describe("unsettledItemDrafts", () => {
  it("settles an interrupted text part with the text already accumulated", () => {
    const drafts = unsettledItemDrafts(
      assistant([textPart("streaming")]),
      context,
      existing(),
      "已取消",
    );

    expect(drafts).toEqual([
      {
        itemId: "p-text",
        status: "interrupted",
        createdAt: AT,
        turnId: TURN,
        messageId: MESSAGE,
        authorAgentId: "general",
        payload: { kind: "text", text: "已经生成的正文" },
      },
    ]);
  });

  it("leaves a settled part alone", () => {
    expect(
      unsettledItemDrafts(assistant([textPart("completed")]), context, existing(), "已取消"),
    ).toEqual([]);
  });

  it("backfills a result for a written tool call without one", () => {
    const drafts = unsettledItemDrafts(
      assistant([toolPart()]),
      context,
      existing("call-1"),
      "已取消",
    );

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      itemId: "call-1:result",
      payload: { kind: "tool-result", outcome: "error", errorText: "已取消" },
    });
  });

  it("skips a tool call that was never written and a call with a result", () => {
    expect(unsettledItemDrafts(assistant([toolPart()]), context, existing(), "已取消")).toEqual([]);
    expect(
      unsettledItemDrafts(
        assistant([toolPart()]),
        context,
        existing("call-1", "call-1:result"),
        "已取消",
      ),
    ).toEqual([]);
  });
});

describe("handoffItemDraft", () => {
  it("writes the handoff task as a text item from the source bot to the target", () => {
    const draft = handoffItemDraft(
      { id: "h-1", fromAgentId: "general", toAgentId: "reviewer", task: "请复核实现" },
      TURN,
      AT,
    );

    expect(draft).toEqual({
      itemId: "h-1:text",
      status: "complete",
      createdAt: AT,
      turnId: TURN,
      messageId: "h-1",
      authorAgentId: "general",
      audienceAgentId: "reviewer",
      payload: { kind: "text", text: "请复核实现" },
    });
  });
});

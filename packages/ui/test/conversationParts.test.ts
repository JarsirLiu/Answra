import type { ConversationMessagePart } from "@answra/shared";
import type { AgentStreamEvent } from "@answra/shared/schema";
import { describe, expect, it } from "vitest";
import {
  applyConversationPartEvent,
  reasoningFromConversationParts,
  settleConversationParts,
  textFromConversationParts,
} from "../src/app/conversationParts";

function apply(parts: readonly ConversationMessagePart[], event: AgentStreamEvent) {
  const next = applyConversationPartEvent(parts, event);
  if (!next) throw new Error(`event ${event.type} did not change parts`);
  return next;
}

describe("conversation part projection", () => {
  it("builds a text part from start, delta, and end without mutating the input", () => {
    const start = apply([], { type: "text-start", partId: "text-1" });
    const streaming = apply(start, { type: "text-delta", partId: "text-1", delta: "你好" });
    const completed = apply(streaming, { type: "text-end", partId: "text-1" });

    expect(start).toHaveLength(1);
    expect(streaming[0]).toMatchObject({ kind: "text", text: "你好", state: "streaming" });
    expect(completed[0]).toMatchObject({ kind: "text", text: "你好", state: "completed" });
    expect(start[0]).toMatchObject({ text: "", state: "started" });
  });

  it("builds a reasoning part and derives the combined reasoning text", () => {
    const start = apply([], { type: "reasoning-start", partId: "reason-1" });
    const streaming = apply(start, {
      type: "reasoning-delta",
      partId: "reason-1",
      delta: "先分析",
    });
    const completed = apply(streaming, { type: "reasoning-end", partId: "reason-1" });

    expect(completed[0]).toMatchObject({
      kind: "reasoning",
      text: "先分析",
      state: "completed",
    });
    expect(reasoningFromConversationParts(completed)).toBe("先分析");
  });

  it("moves one tool call through input, pending, running, and completed states", () => {
    let parts = apply([], {
      type: "tool-input-start",
      toolCallId: "tool-1",
      toolName: "Read",
      title: "读取文件",
    });
    parts = apply(parts, { type: "tool-input-delta", toolCallId: "tool-1", delta: '{"file_path"' });
    parts = apply(parts, { type: "tool-input-end", toolCallId: "tool-1" });
    parts = apply(parts, {
      type: "tool-call",
      toolCallId: "tool-1",
      toolName: "Read",
      input: { file_path: "a.ts" },
    });
    parts = apply(parts, {
      type: "tool-execution-started",
      toolCallId: "tool-1",
      toolName: "Read",
      input: { file_path: "a.ts" },
    });
    parts = apply(parts, {
      type: "tool-execution-finished",
      toolCallId: "tool-1",
      toolName: "Read",
      input: { file_path: "a.ts" },
      result: { success: true, output: "content" },
      durationMs: 12,
    });

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      kind: "tool",
      toolCallId: "tool-1",
      toolName: "Read",
      title: "读取文件",
      state: "completed",
      input: { file_path: "a.ts" },
      output: "content",
    });
    expect(parts[0]).toMatchObject({ inputText: '{"file_path"' });
  });

  it("records failed and denied tool outcomes without dropping the input", () => {
    const called = apply([], {
      type: "tool-call",
      toolCallId: "tool-1",
      toolName: "RunCommand",
      input: { command: "pwd" },
    });
    const failed = apply(called, {
      type: "tool-error",
      toolCallId: "tool-1",
      errorText: "spawn failed",
    });
    expect(failed[0]).toMatchObject({
      state: "failed",
      errorText: "spawn failed",
      input: { command: "pwd" },
    });

    const denied = apply(called, {
      type: "tool-output-denied",
      toolCallId: "tool-1",
      toolName: "RunCommand",
    });
    expect(denied[0]).toMatchObject({ state: "denied", input: { command: "pwd" } });
  });

  it("ignores events that do not describe rendered content", () => {
    expect(
      applyConversationPartEvent([], { type: "finish", finishReason: "stop" }),
    ).toBeUndefined();
    expect(applyConversationPartEvent([], { type: "text-end", partId: "missing" })).toBeUndefined();
    expect(
      applyConversationPartEvent([], {
        type: "tool-execution-started",
        toolCallId: "missing",
        toolName: "Read",
        input: {},
      }),
    ).toBeUndefined();
  });

  it("settles only non-terminal parts when a run ends abnormally", () => {
    const parts: ConversationMessagePart[] = [
      { id: "text-1", kind: "text", text: "答案", state: "streaming" },
      { id: "reason-1", kind: "reasoning", text: "思考", state: "completed" },
      {
        id: "tool-1",
        kind: "tool",
        toolCallId: "tool-1",
        toolName: "Read",
        state: "running",
      },
      {
        id: "tool-2",
        kind: "tool",
        toolCallId: "tool-2",
        toolName: "Read",
        state: "completed",
      },
    ];

    const settled = settleConversationParts(parts, "failed");
    expect(settled.map((part) => part.state)).toEqual([
      "failed",
      "completed",
      "failed",
      "completed",
    ]);
    expect(textFromConversationParts(settled)).toBe("答案");
  });
});

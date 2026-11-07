import type { TextStreamPart, ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { normalizeStreamPart } from "../../../src/core/model/streamEvents";

describe("normalizeStreamPart", () => {
  it("normalizes fullStream content, tool and source events", () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", text: "answer" },
      { type: "text-end", id: "text-1" },
      { type: "reasoning-start", id: "reason-1" },
      { type: "reasoning-delta", id: "reason-1", text: "think" },
      { type: "reasoning-end", id: "reason-1" },
      { type: "tool-input-start", id: "tool-1", toolName: "Read", title: "读取" },
      { type: "tool-input-delta", id: "tool-1", delta: "{" },
      { type: "tool-input-end", id: "tool-1" },
      {
        type: "tool-call",
        toolCallId: "tool-1",
        toolName: "Read",
        input: { path: "a" },
        providerExecuted: false,
      },
      {
        type: "tool-result",
        toolCallId: "tool-1",
        toolName: "Read",
        input: { path: "a" },
        output: "ok",
      },
      {
        type: "tool-error",
        toolCallId: "tool-2",
        toolName: "Read",
        input: { path: "b" },
        error: new Error("boom"),
      },
      {
        type: "tool-output-denied",
        toolCallId: "tool-3",
        toolName: "Read",
      },
      {
        type: "tool-approval-request",
        approvalId: "approval-1",
        toolCall: {
          type: "tool-call",
          toolCallId: "tool-4",
          toolName: "Read",
          input: { path: "c" },
          providerExecuted: false,
        },
        signature: "sig",
      },
      {
        type: "source",
        sourceType: "url",
        id: "source-1",
        url: "https://example.com",
      },
      {
        type: "source",
        sourceType: "document",
        id: "source-2",
        mediaType: "text/plain",
        title: "doc",
      },
      {
        type: "file",
        file: { base64: "eA==", uint8Array: new Uint8Array([120]), mediaType: "text/plain" },
      },
    ];

    expect(
      parts.flatMap((part) => {
        const normalized = normalizeStreamPart(part, { stepIndex: 0 });
        if (normalized === undefined) return [];
        return Array.isArray(normalized) ? normalized : [normalized];
      }),
    ).toEqual([
      { type: "text-start", partId: "text-1" },
      { type: "text-delta", partId: "text-1", delta: "answer" },
      { type: "text-end", partId: "text-1" },
      { type: "reasoning-start", partId: "reason-1" },
      { type: "reasoning-delta", partId: "reason-1", delta: "think" },
      { type: "reasoning-end", partId: "reason-1" },
      { type: "tool-input-start", toolCallId: "tool-1", toolName: "Read", title: "读取" },
      { type: "tool-input-delta", toolCallId: "tool-1", delta: "{" },
      { type: "tool-input-end", toolCallId: "tool-1" },
      { type: "tool-call", toolCallId: "tool-1", toolName: "Read", input: { path: "a" } },
      { type: "tool-result", toolCallId: "tool-1", output: "ok" },
      { type: "tool-error", toolCallId: "tool-2", errorText: "boom" },
      { type: "tool-output-denied", toolCallId: "tool-3", toolName: "Read" },
      {
        type: "tool-approval-request",
        approvalId: "approval-1",
        toolCallId: "tool-4",
        toolName: "Read",
        input: { path: "c" },
        signature: "sig",
      },
      { type: "source-url", sourceId: "source-1", url: "https://example.com" },
      {
        type: "source-document",
        sourceId: "source-2",
        mediaType: "text/plain",
        title: "doc",
      },
      { type: "file", mediaType: "text/plain", base64: "eA==" },
    ]);
  });

  it("keeps generation and step lifecycle facts in the Agent event union", () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: "start" },
      {
        type: "start-step",
        request: {},
        warnings: [{ type: "unsupported", feature: "temperature", details: "ignored" }],
      },
      {
        type: "finish-step",
        response: { id: "response-1", timestamp: new Date(0), modelId: "model-1" },
        usage: {
          inputTokens: 2,
          inputTokenDetails: {
            noCacheTokens: 1,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
          outputTokens: 3,
          outputTokenDetails: { textTokens: 2, reasoningTokens: 1 },
          totalTokens: 5,
        },
        finishReason: "stop",
        rawFinishReason: "stop",
        providerMetadata: undefined,
      },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: {
          inputTokens: 2,
          inputTokenDetails: {
            noCacheTokens: 1,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
          outputTokens: 3,
          outputTokenDetails: { textTokens: 2, reasoningTokens: 1 },
          totalTokens: 5,
        },
      },
      { type: "abort", reason: "cancelled" },
      { type: "error", error: new Error("failed") },
    ];

    expect(
      parts.flatMap((part) => {
        const normalized = normalizeStreamPart(part, { stepIndex: 2 });
        if (normalized === undefined) return [];
        return Array.isArray(normalized) ? normalized : [normalized];
      }),
    ).toEqual([
      { type: "start" },
      { type: "step-started", stepId: "step-2", index: 2 },
      {
        type: "model-warning-unsupported",
        feature: "temperature",
        details: "ignored",
      },
      {
        type: "step-finished",
        stepId: "step-2",
        index: 2,
        state: "completed",
        finishReason: "stop",
        usage: {
          inputTokens: 2,
          outputTokens: 3,
          totalTokens: 5,
          inputTokenDetails: { noCacheTokens: 1 },
          outputTokenDetails: { textTokens: 2, reasoningTokens: 1 },
        },
      },
      {
        type: "finish",
        finishReason: "stop",
        usage: {
          inputTokens: 2,
          outputTokens: 3,
          totalTokens: 5,
          inputTokenDetails: { noCacheTokens: 1 },
          outputTokenDetails: { textTokens: 2, reasoningTokens: 1 },
        },
      },
      { type: "abort", reason: "cancelled" },
      { type: "error", errorText: "failed" },
    ]);
  });

  it("does not persist raw provider chunks", () => {
    const raw: TextStreamPart<ToolSet> = { type: "raw", rawValue: { secret: "provider" } };
    expect(normalizeStreamPart(raw, { stepIndex: -1 })).toBeUndefined();
  });
});

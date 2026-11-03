import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { normalizeStreamChunk } from "../../src/core/streamEvents";

describe("normalizeStreamChunk", () => {
  it("keeps content parts and tool/source events in the app-owned shape", () => {
    const chunks: UIMessageChunk[] = [
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "answer" },
      { type: "text-end", id: "text-1" },
      { type: "reasoning-start", id: "reason-1" },
      { type: "reasoning-delta", id: "reason-1", delta: "think" },
      { type: "reasoning-end", id: "reason-1" },
      { type: "tool-input-start", toolCallId: "tool-1", toolName: "Read", title: "读取" },
      { type: "tool-input-delta", toolCallId: "tool-1", inputTextDelta: "{" },
      {
        type: "tool-input-available",
        toolCallId: "tool-1",
        toolName: "Read",
        input: { path: "a" },
      },
      { type: "tool-output-available", toolCallId: "tool-1", output: "ok" },
      { type: "tool-output-error", toolCallId: "tool-1", errorText: "boom" },
      { type: "source-url", sourceId: "source-1", url: "https://example.com" },
      {
        type: "source-document",
        sourceId: "source-2",
        mediaType: "text/plain",
        title: "doc",
      },
      { type: "error", errorText: "failed" },
    ];

    expect(chunks.map(normalizeStreamChunk)).toEqual([
      { type: "text-start", partId: "text-1" },
      { type: "text-delta", partId: "text-1", delta: "answer" },
      { type: "text-end", partId: "text-1" },
      { type: "reasoning-start", partId: "reason-1" },
      { type: "reasoning-delta", partId: "reason-1", delta: "think" },
      { type: "reasoning-end", partId: "reason-1" },
      { type: "tool-input-start", toolCallId: "tool-1", toolName: "Read", title: "读取" },
      { type: "tool-input-delta", toolCallId: "tool-1", delta: "{" },
      { type: "tool-call", toolCallId: "tool-1", toolName: "Read", input: { path: "a" } },
      { type: "tool-result", toolCallId: "tool-1", output: "ok" },
      { type: "tool-error", toolCallId: "tool-1", errorText: "boom" },
      { type: "source-url", sourceId: "source-1", url: "https://example.com" },
      {
        type: "source-document",
        sourceId: "source-2",
        mediaType: "text/plain",
        title: "doc",
      },
      { type: "error", errorText: "failed" },
    ]);
  });

  it("drops transport framing and provider-only parts", () => {
    const chunks: UIMessageChunk[] = [
      { type: "finish", finishReason: "stop" },
      { type: "abort" },
      { type: "start-step" },
      { type: "finish-step" },
      { type: "message-metadata", messageMetadata: {} },
      { type: "file", url: "data:text/plain,x", mediaType: "text/plain" },
    ];

    expect(chunks.map(normalizeStreamChunk)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

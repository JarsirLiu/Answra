import { describe, expect, it } from "vitest";
import {
  agentStreamEventSchema,
  conversationChangeSchema,
  conversationEventSchema,
} from "../src/schema";

describe("event schema", () => {
  it("round-trips every app-owned stream event kind", () => {
    const events = [
      { type: "start" },
      { type: "text-start", partId: "text-1" },
      { type: "text-delta", partId: "text-1", delta: "answer" },
      { type: "text-end", partId: "text-1" },
      { type: "reasoning-start", partId: "reason-1" },
      { type: "reasoning-delta", partId: "reason-1", delta: "think" },
      { type: "reasoning-end", partId: "reason-1" },
      { type: "tool-input-start", toolCallId: "tool-1", toolName: "Read" },
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
    ] as const;

    for (const event of events) {
      expect(agentStreamEventSchema.parse(event)).toEqual(event);
    }
  });

  it("rejects provider-only fields that are not part of the app contract", () => {
    expect(
      agentStreamEventSchema.safeParse({
        type: "text-delta",
        partId: "text-1",
        delta: "answer",
        providerMetadata: { vendor: "x" },
      }).success,
    ).toBe(false);
  });

  it("round-trips a persisted run event with seq and outcome", () => {
    const event = conversationEventSchema.parse({
      conversationId: "conversation",
      runId: "run-1",
      seq: 2,
      revision: 4,
      stream: { type: "text-delta", partId: "text-1", delta: "answer" },
    });
    expect(event).toMatchObject({ seq: 2, revision: 4, stream: { type: "text-delta" } });

    const change = conversationChangeSchema.parse({
      type: "run-finished",
      conversationId: "conversation",
      revision: 5,
      runId: "run-1",
      outcome: "failed",
      message: {
        id: "run-1",
        role: "assistant",
        text: "",
        images: [],
        status: "failed",
      },
    });
    expect(change).toMatchObject({ outcome: "failed", message: { status: "failed" } });
  });
});

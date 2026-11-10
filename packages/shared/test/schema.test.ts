import { describe, expect, it } from "vitest";
import {
  agentConnectionStateSchema,
  agentDurableEventSchema,
  agentEventEnvelopeSchema,
  agentEventSchema,
  agentExecutionEventSchema,
  agentRunSnapshotSchema,
  agentStreamEventSchema,
  conversationMessagePartSchema,
  conversationMessageSchema,
} from "../src/schema";

describe("event schema", () => {
  it("round-trips every model event through the complete Agent event catalog", () => {
    const events = [
      { type: "start" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 2, outputTokens: 3 } },
      { type: "abort", reason: "cancelled" },
      { type: "text-start", partId: "text-1" },
      { type: "text-delta", partId: "text-1", delta: "answer" },
      { type: "text-end", partId: "text-1" },
      { type: "reasoning-start", partId: "reason-1" },
      { type: "reasoning-delta", partId: "reason-1", delta: "think" },
      { type: "reasoning-end", partId: "reason-1" },
      { type: "tool-input-start", toolCallId: "tool-1", toolName: "Read" },
      { type: "tool-input-delta", toolCallId: "tool-1", delta: "{" },
      { type: "tool-input-end", toolCallId: "tool-1" },
      { type: "tool-output-delta", toolCallId: "tool-1", delta: "partial" },
      { type: "tool-call", toolCallId: "tool-1", toolName: "Read", input: { path: "a" } },
      { type: "tool-result", toolCallId: "tool-1", output: "ok" },
      { type: "tool-error", toolCallId: "tool-1", errorText: "boom" },
      { type: "tool-output-denied", toolCallId: "tool-1", toolName: "Read" },
      {
        type: "tool-approval-request",
        approvalId: "approval-1",
        toolCallId: "tool-1",
        toolName: "Read",
        input: { path: "a" },
      },
      {
        type: "tool-execution-started",
        toolCallId: "tool-1",
        toolName: "Read",
        input: { path: "a" },
        stepNumber: 0,
      },
      {
        type: "tool-execution-finished",
        toolCallId: "tool-1",
        toolName: "Read",
        input: { path: "a" },
        result: { success: true, output: "ok" },
        durationMs: 12,
        stepNumber: 0,
      },
      {
        type: "tool-execution-finished",
        toolCallId: "tool-2",
        toolName: "Read",
        input: { path: "b" },
        result: { success: false, errorText: "denied" },
        durationMs: 3,
      },
      { type: "model-warning-unsupported", feature: "temperature", details: "ignored" },
      { type: "model-warning-compatibility", feature: "json mode" },
      { type: "model-warning-other", message: "provider warning" },
      { type: "source-url", sourceId: "source-1", url: "https://example.com" },
      {
        type: "source-document",
        sourceId: "source-2",
        mediaType: "text/plain",
        title: "doc",
      },
      { type: "file", mediaType: "text/plain", base64: "eA==" },
      {
        type: "retry",
        kind: "rate-limit",
        attempt: 1,
        maxRetries: 5,
        delayMs: 5_000,
      },
      { type: "error", errorText: "failed" },
    ] as const;

    const liveOnlyEventTypes = new Set([
      "text-delta",
      "reasoning-delta",
      "tool-input-delta",
      "tool-output-delta",
    ]);
    for (const event of events) {
      expect(agentStreamEventSchema.parse(event)).toEqual(event);
      expect(agentEventSchema.parse(event)).toEqual(event);
      expect(agentDurableEventSchema.safeParse(event).success).toBe(
        !liveOnlyEventTypes.has(event.type),
      );
    }

    expect(agentStreamEventSchema.options).toHaveLength(28);
  });

  it("includes every execution event in the complete and durable catalogs", () => {
    const events = [
      { type: "run-state-changed", state: "running", attempt: 1 },
      { type: "step-started", stepId: "step-1", index: 0 },
      { type: "step-finished", stepId: "step-1", index: 0, state: "completed" },
      { type: "part-state-changed", partId: "part-1", kind: "text", state: "started" },
    ] as const;

    for (const event of events) {
      expect(agentExecutionEventSchema.parse(event)).toEqual(event);
      expect(agentEventSchema.parse(event)).toEqual(event);
      expect(agentDurableEventSchema.parse(event)).toEqual(event);
    }

    expect(agentExecutionEventSchema.options).toHaveLength(4);
    expect(agentEventSchema.options).toHaveLength(32);
    expect(agentDurableEventSchema.options).toHaveLength(28);
  });

  it("rejects provider-only fields that are not part of the app contract", () => {
    expect(
      agentEventSchema.safeParse({
        type: "text-delta",
        partId: "text-1",
        delta: "answer",
        providerMetadata: { vendor: "x" },
      }).success,
    ).toBe(false);
  });

  it("uses one envelope schema for both lifecycle and model stream facts", () => {
    const envelope = agentEventEnvelopeSchema.parse({
      schemaVersion: 1,
      eventId: "event-2",
      conversationId: "conversation",
      runId: "run-1",
      attemptId: "attempt-1",
      sequence: 2,
      aggregateRevision: 2,
      producerId: "agent-local-1",
      occurredAt: "2026-11-06T00:00:01.000Z",
      event: { type: "text-delta", partId: "text-1", delta: "answer" },
    });
    expect(envelope.event).toEqual({ type: "text-delta", partId: "text-1", delta: "answer" });
  });

  it("accepts execution facts needed for future hosted adapters", () => {
    expect(
      agentRunSnapshotSchema.parse({
        runId: "run-1",
        state: "retry-wait",
        attempt: 2,
        generation: 0,
        updatedAt: "2026-11-06T00:00:00.000Z",
      }),
    ).toMatchObject({ state: "retry-wait" });
    expect(
      agentEventEnvelopeSchema.parse({
        schemaVersion: 1,
        eventId: "event-1",
        conversationId: "conversation",
        runId: "run-1",
        attemptId: "attempt-1",
        sequence: 1,
        aggregateRevision: 1,
        producerId: "agent-local-1",
        occurredAt: "2026-11-06T00:00:00.000Z",
        event: { type: "run-state-changed", state: "running", attempt: 1 },
      }),
    ).toMatchObject({ event: { state: "running" } });
  });
});

describe("execution status schema", () => {
  it("shares message status vocabulary with transcript", () => {
    expect(
      conversationMessageSchema.parse({
        id: "message-1",
        role: "assistant",
        text: "answer",
        images: [],
        status: "complete",
      }).status,
    ).toBe("complete");
  });
});

describe("agent connection schema", () => {
  it("round-trips every connection phase with epoch timestamps and stable reasons", () => {
    const states = [
      {
        target: "agent-service",
        revision: 1,
        updatedAt: 1_000,
        status: "connecting",
        attempt: 1,
        maxAttempts: 5,
      },
      {
        target: "agent-service",
        revision: 2,
        updatedAt: 1_100,
        status: "connected",
        attempt: 2,
        maxAttempts: 5,
        connectedAt: 1_100,
      },
      {
        target: "agent-service",
        revision: 3,
        updatedAt: 1_200,
        status: "reconnecting",
        attempt: 3,
        maxAttempts: 5,
        nextRetryAt: 1_800,
        reason: "readiness-timeout",
        detail: "worker readiness timed out",
      },
      {
        target: "agent-service",
        revision: 4,
        updatedAt: 1_900,
        status: "unavailable",
        attempt: 5,
        maxAttempts: 5,
        reason: "worker-exit",
      },
    ];

    for (const state of states) {
      expect(agentConnectionStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
    }
  });
});

describe("transcript message part schema", () => {
  it("accepts text, reasoning, and tool content with explicit discriminants", () => {
    expect(
      conversationMessagePartSchema.parse({
        id: "reason-1",
        kind: "reasoning",
        text: "considering",
        state: "streaming",
      }),
    ).toMatchObject({ kind: "reasoning", state: "streaming" });
    expect(
      conversationMessagePartSchema.parse({
        id: "tool-1",
        kind: "tool",
        toolCallId: "tool-1",
        toolName: "Search",
        state: "completed",
        output: "result",
      }),
    ).toMatchObject({ kind: "tool", state: "completed" });
  });
});

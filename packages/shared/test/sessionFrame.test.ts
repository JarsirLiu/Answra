import { describe, expect, it } from "vitest";
import {
  liveFrameSchema,
  type SessionEventEnvelope,
  sessionEventEnvelopeSchema,
  sessionFrameSchema,
  toSessionFrame,
} from "../src/schema";

function journalEnvelope(overrides: Partial<SessionEventEnvelope> = {}): SessionEventEnvelope {
  return sessionEventEnvelopeSchema.parse({
    schemaVersion: 1,
    eventId: "event-1",
    sessionId: "conversation-1",
    turnId: "turn-1",
    messageId: "message-1",
    sequence: 3,
    producerId: "answra-agent",
    occurredAt: "2026-11-22T10:00:00.000Z",
    event: { type: "turn-started", agentId: "general" },
    ...overrides,
  });
}

describe("SessionFrame", () => {
  it("carries journal facts with routing fields and the durable seq", () => {
    const frame = toSessionFrame(journalEnvelope());

    expect(frame).toEqual({
      schemaVersion: 2,
      sessionId: "conversation-1",
      seq: 3,
      eventId: "event-1",
      occurredAt: "2026-11-22T10:00:00.000Z",
      producerId: "answra-agent",
      turnId: "turn-1",
      messageId: "message-1",
      event: { type: "turn-started", agentId: "general" },
    });
    expect(sessionFrameSchema.parse(JSON.parse(JSON.stringify(frame)))).toEqual(frame);
  });

  it("omits routing fields that the fact does not own", () => {
    const frame = toSessionFrame(
      journalEnvelope({ turnId: undefined, messageId: undefined, stepId: undefined }),
    );

    expect("turnId" in frame).toBe(false);
    expect("messageId" in frame).toBe(false);
    expect("stepId" in frame).toBe(false);
    expect(sessionFrameSchema.parse(frame).seq).toBe(3);
  });

  it("rejects live-only deltas because they are never durable facts", () => {
    const frame = {
      schemaVersion: 2,
      sessionId: "conversation-1",
      seq: 4,
      eventId: "event-4",
      occurredAt: "2026-11-22T10:00:01.000Z",
      producerId: "answra-agent",
      messageId: "message-1",
      event: { type: "text-delta", partId: "text-1", delta: "a" },
    };

    expect(sessionFrameSchema.safeParse(frame).success).toBe(false);
  });

  it("rejects derived run lifecycle because it is a projection, not a fact", () => {
    expect(
      sessionFrameSchema.safeParse({
        schemaVersion: 2,
        sessionId: "conversation-1",
        seq: 5,
        eventId: "event-5",
        occurredAt: "2026-11-22T10:00:02.000Z",
        producerId: "answra-agent",
        messageId: "message-1",
        event: { type: "run-state-changed", state: "running", attempt: 1 },
      }).success,
    ).toBe(false);
  });

  it("requires a positive integer seq", () => {
    for (const seq of [0, -1, 1.5]) {
      const frame = { ...toSessionFrame(journalEnvelope()), seq };
      expect(sessionFrameSchema.safeParse(frame).success).toBe(false);
    }
  });

  it("carries a settled session item on the same seq cursor", () => {
    const frame = {
      schemaVersion: 2,
      sessionId: "conversation-1",
      seq: 6,
      eventId: "event-6",
      occurredAt: "2026-11-22T10:00:03.000Z",
      producerId: "answra-agent",
      event: {
        type: "session-item",
        item: {
          seq: 6,
          itemId: "message-1",
          status: "complete",
          createdAt: "2026-11-22T10:00:03.000Z",
          turnId: "turn-1",
          payload: { kind: "user", text: "继续", images: [] },
        },
      },
    };

    expect(sessionFrameSchema.parse(JSON.parse(JSON.stringify(frame)))).toEqual(frame);
  });

  it("rejects a session item that breaks the item contract", () => {
    const frame = {
      schemaVersion: 2,
      sessionId: "conversation-1",
      seq: 7,
      eventId: "event-7",
      occurredAt: "2026-11-22T10:00:04.000Z",
      producerId: "answra-agent",
      event: {
        type: "session-item",
        item: {
          seq: 7,
          itemId: "text-1",
          status: "complete",
          createdAt: "2026-11-22T10:00:04.000Z",
          payload: { kind: "text", text: "缺消息 id" },
        },
      },
    };

    expect(sessionFrameSchema.safeParse(frame).success).toBe(false);
  });
});

describe("LiveFrame", () => {
  it("accepts every live-only delta without a cursor", () => {
    const deltas = [
      { type: "text-delta", partId: "text-1", delta: "answer" },
      { type: "reasoning-delta", partId: "reason-1", delta: "think" },
      { type: "tool-input-delta", toolCallId: "tool-1", delta: "{" },
      { type: "tool-output-delta", toolCallId: "tool-1", delta: "partial" },
    ] as const;

    for (const event of deltas) {
      const frame = { sessionId: "conversation-1", messageId: "message-1", event };
      expect(liveFrameSchema.parse(JSON.parse(JSON.stringify(frame)))).toEqual(frame);
    }
  });

  it("rejects durable facts because they belong to the SessionFrame channel", () => {
    expect(
      liveFrameSchema.safeParse({
        sessionId: "conversation-1",
        messageId: "message-1",
        event: { type: "turn-finished", status: "completed" },
      }).success,
    ).toBe(false);
  });
});

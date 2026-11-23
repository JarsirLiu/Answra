import { describe, expect, it } from "vitest";
import {
  liveFrameSchema,
  SESSION_FRAME_SCHEMA_VERSION,
  type SessionItem,
  sessionFrameSchema,
  toSessionItemFrame,
} from "../src/schema";

const AT = "2026-11-22T10:00:00.000Z";

function userItem(overrides: Partial<SessionItem> = {}): SessionItem {
  return {
    seq: 3,
    itemId: "message-1",
    status: "complete",
    createdAt: AT,
    turnId: "turn-1",
    payload: { kind: "user", text: "继续", images: [] },
    ...overrides,
  };
}

function textItem(): SessionItem {
  return {
    seq: 4,
    itemId: "text-1",
    status: "complete",
    createdAt: AT,
    turnId: "turn-1",
    messageId: "message-1",
    payload: { kind: "text", text: "答案" },
  };
}

function parse(value: unknown) {
  return sessionFrameSchema.parse(JSON.parse(JSON.stringify(value)));
}

describe("SessionFrame", () => {
  it("carries a settled item with routing fields and the durable seq", () => {
    const frame = toSessionItemFrame("conversation-1", textItem(), "answra-agent");

    expect(frame).toEqual({
      schemaVersion: SESSION_FRAME_SCHEMA_VERSION,
      sessionId: "conversation-1",
      seq: 4,
      eventId: "conversation-1:4",
      occurredAt: AT,
      producerId: "answra-agent",
      turnId: "turn-1",
      messageId: "message-1",
      event: { type: "session-item", item: textItem() },
    });
    expect(parse(frame)).toEqual(frame);
  });

  it("omits routing fields that the item does not own", () => {
    const frame = toSessionItemFrame("conversation-1", userItem(), "answra-agent");

    expect("messageId" in frame).toBe(false);
    expect("stepId" in frame).toBe(false);
    expect(parse(frame).seq).toBe(3);
  });

  it("rejects durable event payloads because the channel only carries items", () => {
    expect(
      sessionFrameSchema.safeParse({
        schemaVersion: SESSION_FRAME_SCHEMA_VERSION,
        sessionId: "conversation-1",
        seq: 5,
        eventId: "event-5",
        occurredAt: AT,
        producerId: "answra-agent",
        messageId: "message-1",
        event: { type: "turn-finished", status: "completed" },
      }).success,
    ).toBe(false);
  });

  it("rejects live-only deltas because they never become durable facts", () => {
    expect(
      sessionFrameSchema.safeParse({
        schemaVersion: SESSION_FRAME_SCHEMA_VERSION,
        sessionId: "conversation-1",
        seq: 6,
        eventId: "event-6",
        occurredAt: AT,
        producerId: "answra-agent",
        messageId: "message-1",
        event: { type: "text-delta", partId: "text-1", delta: "a" },
      }).success,
    ).toBe(false);
  });

  it("requires a positive integer seq", () => {
    for (const seq of [0, -1, 1.5]) {
      expect(sessionFrameSchema.safeParse({ ...parse(userFrame()), seq }).success).toBe(false);
    }
  });

  it("rejects a session item that breaks the item contract", () => {
    expect(
      sessionFrameSchema.safeParse({
        ...parse(userFrame()),
        event: {
          type: "session-item",
          item: {
            seq: 7,
            itemId: "text-1",
            status: "complete",
            createdAt: AT,
            payload: { kind: "text", text: "缺消息 id" },
          },
        },
      }).success,
    ).toBe(false);
  });
});

function userFrame() {
  return toSessionItemFrame("conversation-1", userItem(), "answra-agent");
}

describe("LiveFrame", () => {
  it("accepts high-frequency deltas and transient run hints without a cursor", () => {
    const events = [
      { type: "text-delta", partId: "text-1", delta: "answer" },
      { type: "reasoning-delta", partId: "reason-1", delta: "think" },
      { type: "tool-input-delta", toolCallId: "tool-1", delta: "{" },
      { type: "tool-output-delta", toolCallId: "tool-1", delta: "partial" },
      {
        type: "retry",
        kind: "rate-limit",
        attempt: 1,
        maxRetries: 5,
        delayMs: 5_000,
      },
      { type: "error", errorText: "boom" },
    ] as const;

    for (const event of events) {
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

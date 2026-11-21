import { describe, expect, it } from "vitest";
import { sessionId, stepId, turnId } from "../../../src/core/session/contracts";
import { createSessionEvent } from "../../../src/core/session/eventFactory";

describe("session contracts", () => {
  it("rejects empty branded ids", () => {
    expect(() => sessionId("")).toThrow("会话 ID 不能为空");
    expect(() => turnId(" ")).toThrow("Turn ID 不能为空");
    expect(() => stepId("")).toThrow("Step ID 不能为空");
  });

  it("builds a session envelope with turn, message and operation identity", () => {
    const envelope = createSessionEvent(
      {
        sessionId: sessionId("session-1"),
        turnId: turnId("turn-1"),
        messageId: "message-1",
        operationId: "operation-1",
        sequence: 3,
        producerId: "test-producer",
        occurredAt: "2026-11-21T00:00:00.000Z",
        eventId: "event-1",
      },
      { type: "turn-finished", status: "completed", reason: "completed" },
    );

    expect(envelope).toMatchObject({
      schemaVersion: 1,
      eventId: "event-1",
      sessionId: "session-1",
      turnId: "turn-1",
      messageId: "message-1",
      operationId: "operation-1",
      sequence: 3,
      producerId: "test-producer",
      occurredAt: "2026-11-21T00:00:00.000Z",
    });
  });

  it("requires a positive integer sequence", () => {
    expect(() =>
      createSessionEvent(
        {
          sessionId: sessionId("session-1"),
          sequence: 0,
        },
        { type: "turn-started", agentId: "general" },
      ),
    ).toThrow("sequence");
  });
});

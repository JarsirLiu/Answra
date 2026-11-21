import { describe, expect, it } from "vitest";
import { projectSession } from "../../../src/core/session/projection";
import {
  sessionEvent,
  TEST_SESSION_ID,
  TEST_STEP_ID,
  TEST_TURN_ID,
  TEST_TURN_ID_2,
  userMessage,
} from "./fixtures";

describe("session projection", () => {
  it("projects FIFO queue and the single active turn", () => {
    const projection = projectSession(TEST_SESSION_ID, [
      sessionEvent(
        1,
        { type: "turn-queued", source: "user", input: userMessage(), agentId: "general" },
        { turnId: TEST_TURN_ID },
      ),
      sessionEvent(
        2,
        {
          type: "turn-queued",
          source: "user",
          input: userMessage("message-2"),
          agentId: "general",
        },
        { turnId: TEST_TURN_ID_2 },
      ),
      sessionEvent(3, { type: "turn-started", agentId: "general" }, { turnId: TEST_TURN_ID }),
    ]);

    expect(projection.queue).toEqual([TEST_TURN_ID_2]);
    expect(projection.activeTurnId).toBe(TEST_TURN_ID);
    expect(projection.turns[0]).toMatchObject({ status: "running", activeAgentId: "general" });
    expect(projection.turns[1]).toMatchObject({ status: "queued" });
  });

  it("keeps handoff in the same turn and tracks assistant messages", () => {
    const projection = projectSession(TEST_SESSION_ID, [
      sessionEvent(
        1,
        { type: "turn-queued", source: "user", input: userMessage(), agentId: "general" },
        { turnId: TEST_TURN_ID },
      ),
      sessionEvent(2, { type: "turn-started", agentId: "general" }, { turnId: TEST_TURN_ID }),
      sessionEvent(
        3,
        { type: "turn-handoff", fromAgentId: "general", toAgentId: "intake", task: "整理资料" },
        { turnId: TEST_TURN_ID, messageId: "handoff-message" },
      ),
    ]);

    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0]).toMatchObject({
      status: "running",
      activeAgentId: "intake",
      handoffCount: 1,
      assistantMessageIds: ["handoff-message"],
    });
  });

  it("records step ownership and usage without changing turn status", () => {
    const projection = projectSession(TEST_SESSION_ID, [
      sessionEvent(
        1,
        { type: "turn-queued", source: "user", input: userMessage(), agentId: "general" },
        { turnId: TEST_TURN_ID },
      ),
      sessionEvent(2, { type: "turn-started", agentId: "general" }, { turnId: TEST_TURN_ID }),
      sessionEvent(
        3,
        {
          type: "step-started",
          stepId: "step-1",
          index: 0,
          agentId: "general",
          modelId: "model-a",
        },
        { turnId: TEST_TURN_ID, stepId: TEST_STEP_ID, messageId: "assistant-1" },
      ),
      sessionEvent(
        4,
        {
          type: "step-finished",
          stepId: "step-1",
          index: 0,
          state: "completed",
          usage: { inputTokens: 10, outputTokens: 4 },
        },
        { turnId: TEST_TURN_ID, stepId: TEST_STEP_ID },
      ),
    ]);

    expect(projection.turns[0]?.status).toBe("running");
    expect(projection.steps[0]).toMatchObject({
      stepId: TEST_STEP_ID,
      turnId: TEST_TURN_ID,
      messageId: "assistant-1",
      agentId: "general",
      modelId: "model-a",
      status: "completed",
      usage: { inputTokens: 10, outputTokens: 4 },
    });
  });

  it("projects context usage and compaction lifecycle", () => {
    const projection = projectSession(TEST_SESSION_ID, [
      sessionEvent(1, { type: "context-usage-changed", usedTokens: 120 }),
      sessionEvent(
        2,
        { type: "compaction-started", trigger: "auto", reason: "threshold" },
        { operationId: "operation-1" },
      ),
      sessionEvent(
        3,
        {
          type: "compaction-finished",
          summarizedMessages: 3,
          summary: "摘要",
          usage: { inputTokens: 8, outputTokens: 2 },
        },
        { operationId: "operation-1" },
      ),
    ]);

    expect(projection.contextUsage).toEqual({
      usedTokens: 120,
      updatedAt: "2026-11-21T00:00:00.000Z",
    });
    expect(projection.compactions[0]).toMatchObject({
      operationId: "operation-1",
      trigger: "auto",
      reason: "threshold",
      status: "finished",
      summarizedMessages: 3,
      summary: "摘要",
    });
  });

  it("terminates a queued turn as aborted and removes it from the queue", () => {
    const projection = projectSession(TEST_SESSION_ID, [
      sessionEvent(
        1,
        { type: "turn-queued", source: "user", input: userMessage(), agentId: "general" },
        { turnId: TEST_TURN_ID },
      ),
      sessionEvent(
        2,
        {
          type: "turn-queued",
          source: "user",
          input: userMessage("message-2"),
          agentId: "general",
        },
        { turnId: TEST_TURN_ID_2 },
      ),
      sessionEvent(
        3,
        { type: "turn-finished", status: "aborted", reason: "cancelled" },
        { turnId: TEST_TURN_ID_2 },
      ),
    ]);

    expect(projection.queue).toEqual([TEST_TURN_ID]);
    expect(projection.turns[1]).toMatchObject({
      status: "aborted",
      finishReason: "cancelled",
    });
  });

  it("rejects a completed terminal event for a queued turn", () => {
    expect(() =>
      projectSession(TEST_SESSION_ID, [
        sessionEvent(
          1,
          { type: "turn-queued", source: "user", input: userMessage(), agentId: "general" },
          { turnId: TEST_TURN_ID },
        ),
        sessionEvent(
          2,
          { type: "turn-finished", status: "completed", reason: "completed" },
          { turnId: TEST_TURN_ID },
        ),
      ]),
    ).toThrow("queued Turn 只能被取消");
  });

  it("clears the active turn on a terminal event", () => {
    const projection = projectSession(TEST_SESSION_ID, [
      sessionEvent(
        1,
        { type: "turn-queued", source: "user", input: userMessage(), agentId: "general" },
        { turnId: TEST_TURN_ID },
      ),
      sessionEvent(2, { type: "turn-started", agentId: "general" }, { turnId: TEST_TURN_ID }),
      sessionEvent(
        3,
        { type: "turn-finished", status: "aborted", reason: "cancelled" },
        { turnId: TEST_TURN_ID },
      ),
    ]);

    expect(projection.activeTurnId).toBeUndefined();
    expect(projection.turns[0]).toMatchObject({
      status: "aborted",
      finishReason: "cancelled",
    });
  });

  it("rejects sequence gaps and a second active turn", () => {
    const queued = sessionEvent(
      1,
      { type: "turn-queued", source: "user", input: userMessage(), agentId: "general" },
      { turnId: TEST_TURN_ID },
    );
    const started = sessionEvent(
      3,
      { type: "turn-started", agentId: "general" },
      {
        turnId: TEST_TURN_ID,
      },
    );

    expect(() => projectSession(TEST_SESSION_ID, [queued, started])).toThrow("sequence 不连续");

    expect(() =>
      projectSession(TEST_SESSION_ID, [
        sessionEvent(
          1,
          { type: "turn-queued", source: "user", input: userMessage(), agentId: "general" },
          { turnId: TEST_TURN_ID },
        ),
        sessionEvent(
          2,
          {
            type: "turn-queued",
            source: "user",
            input: userMessage("message-2"),
            agentId: "general",
          },
          { turnId: TEST_TURN_ID_2 },
        ),
        sessionEvent(3, { type: "turn-started", agentId: "general" }, { turnId: TEST_TURN_ID }),
        sessionEvent(4, { type: "turn-started", agentId: "general" }, { turnId: TEST_TURN_ID_2 }),
      ]),
    ).toThrow("只能有一个活动 turn");
  });
});

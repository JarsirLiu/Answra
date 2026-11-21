import { describe, expect, it } from "vitest";
import { planSessionRecovery } from "../../../src/core/session/recovery";
import {
  sessionEvent,
  TEST_SESSION_ID,
  TEST_STEP_ID,
  TEST_TURN_ID,
  TEST_TURN_ID_2,
  userMessage,
} from "./fixtures";

describe("session recovery", () => {
  it("reports started turns, steps and compactions without a terminal event", () => {
    const plan = planSessionRecovery(TEST_SESSION_ID, [
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
        { turnId: TEST_TURN_ID, stepId: TEST_STEP_ID },
      ),
      sessionEvent(
        4,
        { type: "compaction-started", trigger: "auto", reason: "provider-overflow" },
        { operationId: "operation-1" },
      ),
    ]);

    expect(plan.interruptedTurnIds).toEqual([TEST_TURN_ID]);
    expect(plan.interruptedStepIds).toEqual([TEST_STEP_ID]);
    expect(plan.interruptedCompactionIds).toEqual(["operation-1"]);
  });

  it("keeps queued turns resumable and ignores completed turns", () => {
    const plan = planSessionRecovery(TEST_SESSION_ID, [
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
      sessionEvent(
        4,
        { type: "turn-finished", status: "completed", reason: "completed" },
        { turnId: TEST_TURN_ID },
      ),
    ]);

    expect(plan.interruptedTurnIds).toEqual([]);
    expect(plan.projection.queue).toEqual([TEST_TURN_ID_2]);
    expect(plan.projection.turns[0]?.status).toBe("completed");
  });
});

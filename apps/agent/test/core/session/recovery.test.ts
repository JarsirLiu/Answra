import { describe, expect, it } from "vitest";
import { MemorySessionJournal } from "../../../src/core/session/memoryJournal";
import { planSessionRecovery, recoverSession } from "../../../src/core/session/recovery";
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

  it("writes recovery facts only for interrupted turns, steps and compactions", async () => {
    const journal = new MemorySessionJournal();
    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-queued", source: "user", input: userMessage("turn-1"), agentId: "general" },
      { turnId: TEST_TURN_ID },
    );
    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-started", agentId: "general" },
      { turnId: TEST_TURN_ID },
    );
    await journal.append(
      TEST_SESSION_ID,
      {
        type: "step-started",
        stepId: "step-1",
        index: 0,
        agentId: "general",
        modelId: "model-a",
      },
      { turnId: TEST_TURN_ID, stepId: TEST_STEP_ID },
    );
    await journal.append(
      TEST_SESSION_ID,
      { type: "compaction-started", trigger: "auto", reason: "threshold" },
      { operationId: "operation-1" },
    );
    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-queued", source: "user", input: userMessage("turn-2"), agentId: "general" },
      { turnId: TEST_TURN_ID_2 },
    );

    const plan = await recoverSession(journal, TEST_SESSION_ID);

    expect(plan.interruptedTurnIds).toEqual([TEST_TURN_ID]);
    expect(plan.interruptedStepIds).toEqual([TEST_STEP_ID]);
    expect(plan.interruptedCompactionIds).toEqual(["operation-1"]);

    const events = await journal.readAfter(TEST_SESSION_ID, 0);
    expect(events.map((event) => event.event.type)).toEqual([
      "turn-queued",
      "turn-started",
      "step-started",
      "compaction-started",
      "turn-queued",
      "step-finished",
      "turn-finished",
      "compaction-failed",
    ]);
    expect(events[5]?.event).toMatchObject({
      type: "step-finished",
      state: "failed",
      finishReason: "error",
      errorText: "Session 恢复时发现 Step 未完成",
    });
    expect(events[6]?.event).toMatchObject({
      type: "turn-finished",
      status: "failed",
      reason: "interrupted",
      errorText: "Session 恢复时发现 Turn 未完成",
    });
    expect(events[7]?.event).toMatchObject({
      type: "compaction-failed",
      errorText: "Session 恢复时发现压缩未完成",
    });

    const secondPlan = await recoverSession(journal, TEST_SESSION_ID);
    expect(secondPlan.interruptedTurnIds).toEqual([]);
    expect(secondPlan.interruptedStepIds).toEqual([]);
    expect(secondPlan.interruptedCompactionIds).toEqual([]);
    expect(await journal.readAfter(TEST_SESSION_ID, 0)).toHaveLength(events.length);
    expect(secondPlan.projection.queue).toEqual([TEST_TURN_ID_2]);
  });
});

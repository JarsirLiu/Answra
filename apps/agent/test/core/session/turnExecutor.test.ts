import { describe, expect, it } from "vitest";
import type {
  StepExecutor,
  StepHandoff,
  StepResult,
  StepStart,
  StoredHandoff,
  TurnRecorder,
  TurnStart,
} from "../../../src/core/session/contracts";
import { SessionTurnExecutor } from "../../../src/core/session/turnExecutor";
import { TEST_SESSION_ID, TEST_TURN_ID, TEST_TURN_RUNTIME, userMessage } from "./fixtures";

class ScriptedStepExecutor implements StepExecutor {
  readonly calls: StepStart[] = [];
  private readonly results: StepResult[];

  constructor(...results: StepResult[]) {
    this.results = results;
  }

  async run(step: StepStart): Promise<StepResult> {
    this.calls.push(step);
    const result = this.results.shift();
    if (result === undefined) throw new Error("测试没有配置下一个 step 结果");
    return result;
  }
}

class RecordingTurnRecorder implements TurnRecorder {
  readonly handoffs: StoredHandoff[] = [];

  async recordUserMessage(): Promise<void> {}
  async beginTurn(): Promise<void> {}
  async finishTurn(): Promise<void> {}
  async cancelQueuedTurn(): Promise<void> {}
  async lastSeq(): Promise<number> {
    return 0;
  }

  async recordHandoff(_sessionId: string, handoff: StoredHandoff): Promise<void> {
    this.handoffs.push(handoff);
  }
}

function turnStart(overrides: Partial<TurnStart> = {}): TurnStart {
  return {
    sessionId: TEST_SESSION_ID,
    turnId: TEST_TURN_ID,
    source: "user",
    agentId: "general",
    messageId: "assistant-1",
    input: userMessage(),
    ...overrides,
  };
}

describe("SessionTurnExecutor", () => {
  it("loops through tool-call steps and reports the turn summary", async () => {
    const stepExecutor = new ScriptedStepExecutor(
      {
        stepId: "step-1" as StepResult["stepId"],
        outcome: "completed",
        finishReason: "tool-calls",
        usage: { inputTokens: 100, outputTokens: 20 },
      },
      {
        stepId: "step-2" as StepResult["stepId"],
        outcome: "completed",
        finishReason: "stop",
        usage: { inputTokens: 150, outputTokens: 30 },
      },
    );
    const executor = new SessionTurnExecutor({
      recorder: new RecordingTurnRecorder(),
      stepExecutor,
      createMessageId: () => "unused",
      now: () => new Date("2026-11-23T10:00:01.000Z"),
    });

    const finish = await executor.run(turnStart(), TEST_TURN_RUNTIME, new AbortController().signal);

    expect(stepExecutor.calls.map((step) => step.index)).toEqual([0, 1]);
    expect(finish).toEqual({
      turnId: TEST_TURN_ID,
      outcome: "completed",
      reason: "completed",
      steps: 2,
      durationMs: expect.any(Number),
      finishReason: "stop",
      usage: { inputTokens: 150, outputTokens: 30 },
    });
  });

  it("continues a recovered context overflow in a new project step", async () => {
    const stepExecutor = new ScriptedStepExecutor(
      {
        stepId: "step-1" as StepResult["stepId"],
        outcome: "completed",
        continuation: "context-recovered",
      },
      {
        stepId: "step-2" as StepResult["stepId"],
        outcome: "completed",
        finishReason: "stop",
      },
    );
    const executor = new SessionTurnExecutor({
      recorder: new RecordingTurnRecorder(),
      stepExecutor,
      createMessageId: () => "unused",
    });

    const finish = await executor.run(turnStart(), TEST_TURN_RUNTIME, new AbortController().signal);

    expect(stepExecutor.calls.map((step) => step.index)).toEqual([0, 1]);
    expect(finish).toMatchObject({ outcome: "completed", steps: 2, finishReason: "stop" });
  });

  it("records the handoff and continues the same turn as the target bot", async () => {
    const recorder = new RecordingTurnRecorder();
    const stepExecutor = new ScriptedStepExecutor(
      {
        stepId: "step-1" as StepResult["stepId"],
        outcome: "completed",
        finishReason: "stop",
        handoff: { toAgentId: "reviewer", task: "请复核实现" },
      },
      {
        stepId: "step-2" as StepResult["stepId"],
        outcome: "completed",
        finishReason: "stop",
      },
    );
    const executor = new SessionTurnExecutor({
      recorder,
      stepExecutor,
      createMessageId: () => "assistant-2",
    });

    const finish = await executor.run(turnStart(), TEST_TURN_RUNTIME, new AbortController().signal);

    expect(recorder.handoffs).toEqual([
      {
        turnId: TEST_TURN_ID,
        fromAgentId: "general",
        toAgentId: "reviewer",
        task: "请复核实现",
        sourceMessageId: "assistant-1",
        nextMessageId: "assistant-2",
      },
    ]);
    const second = stepExecutor.calls[1];
    expect(second).toMatchObject({ agentId: "reviewer", messageId: "assistant-2" });
    expect(second?.handoff).toEqual({
      fromAgentId: "general",
      task: "请复核实现",
      sourceMessageId: "assistant-1",
    } satisfies StepHandoff);
    expect(finish.outcome).toBe("completed");
    expect(finish.steps).toBe(2);
  });

  it("fails the turn when the handoff target is invalid", async () => {
    const recorder = new RecordingTurnRecorder();
    const stepExecutor = new ScriptedStepExecutor({
      stepId: "step-1" as StepResult["stepId"],
      outcome: "completed",
      finishReason: "stop",
      handoff: { toAgentId: "general", task: "交给自己" },
    });
    const executor = new SessionTurnExecutor({
      recorder,
      stepExecutor,
      createMessageId: () => "m",
    });

    const finish = await executor.run(turnStart(), TEST_TURN_RUNTIME, new AbortController().signal);

    expect(finish).toMatchObject({ outcome: "failed", reason: "handoff-failed" });
    expect(recorder.handoffs).toEqual([]);
    expect(stepExecutor.calls).toHaveLength(1);
  });

  it("stops after the configured maximum number of steps", async () => {
    const stepExecutor = new ScriptedStepExecutor(
      {
        stepId: "step-1" as StepResult["stepId"],
        outcome: "completed",
        finishReason: "tool-calls",
      },
      {
        stepId: "step-2" as StepResult["stepId"],
        outcome: "completed",
        finishReason: "tool-calls",
      },
    );
    const executor = new SessionTurnExecutor({
      recorder: new RecordingTurnRecorder(),
      stepExecutor,
      createMessageId: () => "m",
      maxSteps: 2,
    });

    const finish = await executor.run(turnStart(), TEST_TURN_RUNTIME, new AbortController().signal);

    expect(finish).toMatchObject({ outcome: "failed", reason: "unknown" });
    expect(finish.errorText).toContain("最大 step 数");
  });

  it("reports a failed step as a failed turn", async () => {
    const stepExecutor = new ScriptedStepExecutor({
      stepId: "step-1" as StepResult["stepId"],
      outcome: "failed",
      errorText: "工具执行失败",
    });
    const executor = new SessionTurnExecutor({
      recorder: new RecordingTurnRecorder(),
      stepExecutor,
      createMessageId: () => "m",
    });

    const finish = await executor.run(turnStart(), TEST_TURN_RUNTIME, new AbortController().signal);

    expect(finish).toMatchObject({
      outcome: "failed",
      reason: "unknown",
      errorText: "工具执行失败",
    });
  });

  it("maps a provider error finish reason to model-error", async () => {
    const stepExecutor = new ScriptedStepExecutor({
      stepId: "step-1" as StepResult["stepId"],
      outcome: "completed",
      finishReason: "error",
      errorText: "模型返回错误",
    });
    const executor = new SessionTurnExecutor({
      recorder: new RecordingTurnRecorder(),
      stepExecutor,
      createMessageId: () => "m",
    });

    const finish = await executor.run(turnStart(), TEST_TURN_RUNTIME, new AbortController().signal);

    expect(finish).toMatchObject({
      outcome: "failed",
      reason: "model-error",
      errorText: "模型返回错误",
    });
  });

  it("returns aborted without running a step when the turn was already cancelled", async () => {
    const stepExecutor = new ScriptedStepExecutor();
    const executor = new SessionTurnExecutor({
      recorder: new RecordingTurnRecorder(),
      stepExecutor,
      createMessageId: () => "m",
    });
    const controller = new AbortController();
    controller.abort();

    const finish = await executor.run(turnStart(), TEST_TURN_RUNTIME, controller.signal);

    expect(finish).toMatchObject({ outcome: "aborted", reason: "cancelled", steps: 0 });
    expect(stepExecutor.calls).toEqual([]);
  });
});

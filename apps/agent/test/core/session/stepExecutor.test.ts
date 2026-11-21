import { describe, expect, it } from "vitest";
import type { StepRunner, StepRunnerResult, StepStart } from "../../../src/core/session/contracts";
import { MemorySessionJournal } from "../../../src/core/session/memoryJournal";
import { SessionStepExecutor } from "../../../src/core/session/stepExecutor";
import { TEST_SESSION_ID, TEST_STEP_ID, TEST_TURN_ID } from "./fixtures";

class FakeStepRunner implements StepRunner {
  readonly calls: StepStart[] = [];
  private readonly results: StepRunnerResult[];

  constructor(...results: StepRunnerResult[]) {
    this.results = results;
  }

  async run(step: StepStart, _signal: AbortSignal): Promise<StepRunnerResult> {
    this.calls.push(step);
    const result = this.results.shift();
    if (result === undefined) throw new Error("测试没有配置下一个 step 结果");
    return result;
  }
}

function stepStart(): StepStart {
  return {
    sessionId: TEST_SESSION_ID,
    turnId: TEST_TURN_ID,
    stepId: TEST_STEP_ID,
    index: 0,
    agentId: "general",
    modelId: "model-a",
    messageId: "assistant-1",
  };
}

describe("SessionStepExecutor", () => {
  it("writes step ownership, usage and context projection", async () => {
    const journal = new MemorySessionJournal();
    const runner = new FakeStepRunner({
      outcome: "completed",
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 4 },
    });
    const executor = new SessionStepExecutor({ journal, runner });

    await expect(executor.run(stepStart(), new AbortController().signal)).resolves.toMatchObject({
      stepId: TEST_STEP_ID,
      outcome: "completed",
      finishReason: "stop",
    });

    const events = await journal.readAfter(TEST_SESSION_ID, 0);
    expect(events.map((event) => event.event.type)).toEqual([
      "step-started",
      "step-finished",
      "context-usage-changed",
    ]);
    expect(events[0]).toMatchObject({
      turnId: TEST_TURN_ID,
      stepId: TEST_STEP_ID,
      messageId: "assistant-1",
      event: { type: "step-started", agentId: "general", modelId: "model-a" },
    });
    expect(events[1]).toMatchObject({
      event: {
        type: "step-finished",
        state: "completed",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 4 },
      },
    });
  });

  it("turns a runner exception into an observable failed step", async () => {
    const journal = new MemorySessionJournal();
    const runner: StepRunner = {
      async run(): Promise<StepRunnerResult> {
        throw new Error("provider failed");
      },
    };
    const executor = new SessionStepExecutor({ journal, runner });

    await expect(executor.run(stepStart(), new AbortController().signal)).resolves.toEqual({
      stepId: TEST_STEP_ID,
      outcome: "failed",
      errorText: "provider failed",
    });

    const events = await journal.readAfter(TEST_SESSION_ID, 0);
    expect(events[1]).toMatchObject({
      event: { type: "step-finished", state: "failed", errorText: "provider failed" },
    });
  });

  it("does not start a step when the turn was already aborted", async () => {
    const journal = new MemorySessionJournal();
    const runner = new FakeStepRunner({ outcome: "completed", finishReason: "stop" });
    const executor = new SessionStepExecutor({ journal, runner });
    const controller = new AbortController();
    controller.abort();

    await expect(executor.run(stepStart(), controller.signal)).resolves.toEqual({
      stepId: TEST_STEP_ID,
      outcome: "aborted",
    });
    expect(runner.calls).toEqual([]);
    expect(await journal.readAfter(TEST_SESSION_ID, 0)).toEqual([]);
  });

  it("records an aborted runner result without inventing an error", async () => {
    const journal = new MemorySessionJournal();
    const runner = new FakeStepRunner({ outcome: "aborted" });
    const executor = new SessionStepExecutor({ journal, runner });

    await expect(executor.run(stepStart(), new AbortController().signal)).resolves.toEqual({
      stepId: TEST_STEP_ID,
      outcome: "aborted",
    });

    const events = await journal.readAfter(TEST_SESSION_ID, 0);
    expect(events[1]).toMatchObject({
      event: { type: "step-finished", state: "aborted" },
    });
    expect(events[1]?.event).not.toHaveProperty("errorText");
  });
});

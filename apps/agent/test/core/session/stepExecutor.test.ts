import { describe, expect, it } from "vitest";
import type {
  StepRunContext,
  StepRunner,
  StepRunnerResult,
  StepStart,
} from "../../../src/core/session/contracts";
import { MemorySessionJournal } from "../../../src/core/session/memoryJournal";
import { SessionStepExecutor } from "../../../src/core/session/stepExecutor";
import {
  TEST_ACCESS_TOKEN,
  TEST_SESSION_ID,
  TEST_STEP_ID,
  TEST_TURN_ID,
  TEST_TURN_RUNTIME,
} from "./fixtures";

class FakeStepRunner implements StepRunner {
  readonly calls: StepStart[] = [];
  private readonly results: StepRunnerResult[];

  constructor(...results: StepRunnerResult[]) {
    this.results = results;
  }

  async run(
    step: StepStart,
    _context: StepRunContext,
    _signal: AbortSignal,
  ): Promise<StepRunnerResult> {
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
    source: "user",
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

    await expect(
      executor.run(stepStart(), TEST_TURN_RUNTIME, new AbortController().signal),
    ).resolves.toMatchObject({
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

  it("passes the turn runtime to the step runner", async () => {
    const journal = new MemorySessionJournal();
    let receivedToken: string | undefined;
    const runner: StepRunner = {
      async run(_step, context): Promise<StepRunnerResult> {
        receivedToken = await context.runtime.getAccessToken();
        return { outcome: "completed", finishReason: "stop" };
      },
    };
    const executor = new SessionStepExecutor({ journal, runner });

    await executor.run(stepStart(), TEST_TURN_RUNTIME, new AbortController().signal);

    expect(receivedToken).toBe(TEST_ACCESS_TOKEN);
  });

  it("writes only durable model events in order and drops live-only deltas", async () => {
    const journal = new MemorySessionJournal();
    const runner: StepRunner = {
      async run(_step, context): Promise<StepRunnerResult> {
        await Promise.all([
          context.events.append({ type: "text-start", partId: "text-1" }),
          context.events.append({ type: "text-delta", partId: "text-1", delta: "a" }),
          context.events.append({ type: "text-delta", partId: "text-1", delta: "b" }),
          context.events.append({ type: "text-end", partId: "text-1" }),
        ]);
        return { outcome: "completed", finishReason: "stop" };
      },
    };
    const executor = new SessionStepExecutor({ journal, runner });

    await executor.run(stepStart(), TEST_TURN_RUNTIME, new AbortController().signal);

    const events = await journal.readAfter(TEST_SESSION_ID, 0);
    expect(events.map((event) => event.event.type)).toEqual([
      "step-started",
      "text-start",
      "text-end",
      "step-finished",
    ]);
    expect(events.slice(1, 3)).toMatchObject([
      {
        turnId: TEST_TURN_ID,
        stepId: TEST_STEP_ID,
        messageId: "assistant-1",
        event: { type: "text-start", partId: "text-1" },
      },
      {
        turnId: TEST_TURN_ID,
        stepId: TEST_STEP_ID,
        messageId: "assistant-1",
        event: { type: "text-end", partId: "text-1" },
      },
    ]);
  });

  it("forwards every model event to the live observer while journaling only durable events", async () => {
    const journal = new MemorySessionJournal();
    const observed: string[] = [];
    const runner: StepRunner = {
      async run(_step, context): Promise<StepRunnerResult> {
        await context.events.append({ type: "text-start", partId: "text-1" });
        await context.events.append({ type: "text-delta", partId: "text-1", delta: "a" });
        await context.events.append({ type: "text-delta", partId: "text-1", delta: "b" });
        await context.events.append({ type: "text-end", partId: "text-1" });
        return { outcome: "completed", finishReason: "stop" };
      },
    };
    const executor = new SessionStepExecutor({
      journal,
      runner,
      onStreamEvent: (step, event) => {
        expect(step.stepId).toBe(TEST_STEP_ID);
        observed.push(event.type);
      },
    });

    await executor.run(stepStart(), TEST_TURN_RUNTIME, new AbortController().signal);

    expect(observed).toEqual(["text-start", "text-delta", "text-delta", "text-end"]);
    const events = await journal.readAfter(TEST_SESSION_ID, 0);
    expect(events.map((event) => event.event.type)).toEqual([
      "step-started",
      "text-start",
      "text-end",
      "step-finished",
    ]);
  });

  it("does not fail the step when a live-only event has no journal counterpart", async () => {
    const journal = new MemorySessionJournal();
    const runner: StepRunner = {
      async run(_step, context): Promise<StepRunnerResult> {
        await context.events.append({ type: "reasoning-delta", partId: "r-1", delta: "x" });
        return { outcome: "completed", finishReason: "stop" };
      },
    };
    const executor = new SessionStepExecutor({
      journal,
      runner,
      onStreamEvent: () => undefined,
    });

    await expect(
      executor.run(stepStart(), TEST_TURN_RUNTIME, new AbortController().signal),
    ).resolves.toMatchObject({ outcome: "completed" });
  });

  it("turns a step event sink failure into an observable failed step", async () => {
    class FailingStreamJournal extends MemorySessionJournal {
      override async append(
        sessionId: Parameters<MemorySessionJournal["append"]>[0],
        event: Parameters<MemorySessionJournal["append"]>[1],
        metadata?: Parameters<MemorySessionJournal["append"]>[2],
      ) {
        if (event.type === "text-end") throw new Error("journal write failed");
        return super.append(sessionId, event, metadata);
      }
    }
    const journal = new FailingStreamJournal();
    const runner: StepRunner = {
      async run(_step, context): Promise<StepRunnerResult> {
        await context.events.append({ type: "text-end", partId: "text-1" });
        return { outcome: "completed", finishReason: "stop" };
      },
    };
    const executor = new SessionStepExecutor({ journal, runner });

    await expect(
      executor.run(stepStart(), TEST_TURN_RUNTIME, new AbortController().signal),
    ).resolves.toEqual({
      stepId: TEST_STEP_ID,
      outcome: "failed",
      errorText: "journal write failed",
    });

    const events = await journal.readAfter(TEST_SESSION_ID, 0);
    expect(events[1]).toMatchObject({
      event: { type: "step-finished", state: "failed", errorText: "journal write failed" },
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

    await expect(
      executor.run(stepStart(), TEST_TURN_RUNTIME, new AbortController().signal),
    ).resolves.toEqual({
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

    await expect(executor.run(stepStart(), TEST_TURN_RUNTIME, controller.signal)).resolves.toEqual({
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

    await expect(
      executor.run(stepStart(), TEST_TURN_RUNTIME, new AbortController().signal),
    ).resolves.toEqual({
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

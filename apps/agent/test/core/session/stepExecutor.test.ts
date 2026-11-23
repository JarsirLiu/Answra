import type { AgentStreamEvent } from "@answra/shared/schema";
import { describe, expect, it } from "vitest";
import type {
  StepEventRecorder,
  StepRunContext,
  StepRunner,
  StepRunnerResult,
  StepStart,
} from "../../../src/core/session/contracts";
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

class RecordingSink implements StepEventRecorder {
  readonly events: AgentStreamEvent[] = [];

  constructor(private readonly failure?: AgentStreamEvent["type"]) {}

  async append(_step: StepStart, event: AgentStreamEvent): Promise<void> {
    if (event.type === this.failure) throw new Error("条目写入失败");
    this.events.push(event);
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
  it("passes the turn runtime to the step runner", async () => {
    let receivedToken: string | undefined;
    const runner: StepRunner = {
      async run(_step, context): Promise<StepRunnerResult> {
        receivedToken = await context.runtime.getAccessToken();
        return { outcome: "completed", finishReason: "stop" };
      },
    };
    const executor = new SessionStepExecutor({ recorder: new RecordingSink(), runner });

    await executor.run(stepStart(), TEST_TURN_RUNTIME, new AbortController().signal);

    expect(receivedToken).toBe(TEST_ACCESS_TOKEN);
  });

  it("forwards every model event to the recorder in order", async () => {
    const recorder = new RecordingSink();
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
    const executor = new SessionStepExecutor({ recorder, runner });

    await executor.run(stepStart(), TEST_TURN_RUNTIME, new AbortController().signal);

    expect(recorder.events.map((event) => event.type)).toEqual([
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
    ]);
  });

  it("turns a recorder failure into an observable failed step", async () => {
    const runner: StepRunner = {
      async run(_step, context): Promise<StepRunnerResult> {
        await context.events.append({ type: "text-end", partId: "text-1" });
        return { outcome: "completed", finishReason: "stop" };
      },
    };
    const executor = new SessionStepExecutor({
      recorder: new RecordingSink("text-end"),
      runner,
    });

    await expect(
      executor.run(stepStart(), TEST_TURN_RUNTIME, new AbortController().signal),
    ).resolves.toEqual({
      stepId: TEST_STEP_ID,
      outcome: "failed",
      errorText: "条目写入失败",
    });
  });

  it("turns a runner exception into an observable failed step", async () => {
    const runner: StepRunner = {
      async run(): Promise<StepRunnerResult> {
        throw new Error("provider failed");
      },
    };
    const executor = new SessionStepExecutor({ recorder: new RecordingSink(), runner });

    await expect(
      executor.run(stepStart(), TEST_TURN_RUNTIME, new AbortController().signal),
    ).resolves.toEqual({
      stepId: TEST_STEP_ID,
      outcome: "failed",
      errorText: "provider failed",
    });
  });

  it("does not start a step when the turn was already aborted", async () => {
    const recorder = new RecordingSink();
    const runner = new FakeStepRunner({ outcome: "completed", finishReason: "stop" });
    const executor = new SessionStepExecutor({ recorder, runner });
    const controller = new AbortController();
    controller.abort();

    await expect(executor.run(stepStart(), TEST_TURN_RUNTIME, controller.signal)).resolves.toEqual({
      stepId: TEST_STEP_ID,
      outcome: "aborted",
    });
    expect(runner.calls).toEqual([]);
    expect(recorder.events).toEqual([]);
  });

  it("reports the settled step result to the usage observer", async () => {
    const observed: StepRunnerResult[] = [];
    const runner = new FakeStepRunner({
      outcome: "completed",
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 4 },
    });
    const executor = new SessionStepExecutor({
      recorder: new RecordingSink(),
      runner,
      onStepFinished: (_step, result) => {
        observed.push(result);
      },
    });

    await executor.run(stepStart(), TEST_TURN_RUNTIME, new AbortController().signal);

    expect(observed).toEqual([
      { outcome: "completed", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 4 } },
    ]);
  });

  it("records an aborted runner result without inventing an error", async () => {
    const runner = new FakeStepRunner({ outcome: "aborted" });
    const executor = new SessionStepExecutor({ recorder: new RecordingSink(), runner });

    await expect(
      executor.run(stepStart(), TEST_TURN_RUNTIME, new AbortController().signal),
    ).resolves.toEqual({
      stepId: TEST_STEP_ID,
      outcome: "aborted",
    });
  });
});

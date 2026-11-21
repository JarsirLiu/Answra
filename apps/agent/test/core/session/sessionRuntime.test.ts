import type { ManualCompactionResult } from "@answra/shared/schema";
import { describe, expect, it } from "vitest";
import type {
  SessionCompactionRequest,
  SessionCompactor,
  StepRunContext,
  StepRunner,
  StepRunnerResult,
  StepStart,
  TurnExecutor,
  TurnFinish,
  TurnId,
  TurnRunContext,
  TurnStart,
} from "../../../src/core/session/contracts";
import { MemorySessionJournal } from "../../../src/core/session/memoryJournal";
import { SessionRuntime } from "../../../src/core/session/sessionRuntime";
import { SessionStepExecutor } from "../../../src/core/session/stepExecutor";
import { SessionTurnExecutor } from "../../../src/core/session/turnExecutor";
import {
  TEST_SESSION_ID,
  TEST_STEP_ID,
  TEST_TURN_ID,
  TEST_TURN_ID_2,
  TEST_TURN_RUNTIME,
  userMessage,
} from "./fixtures";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveResult) => {
    resolve = resolveResult;
  });
  return { promise, resolve };
}

class StopRunner implements StepRunner {
  async run(): Promise<StepRunnerResult> {
    return { outcome: "completed", finishReason: "stop" };
  }
}

class TokenRecordingRunner implements StepRunner {
  readonly tokens: string[] = [];
  readonly firstStarted = deferred<void>();
  private readonly releaseFirst = deferred<void>();

  async run(step: StepStart, context: StepRunContext): Promise<StepRunnerResult> {
    this.tokens.push(await context.runtime.getAccessToken());
    if (step.turnId === TEST_TURN_ID) {
      this.firstStarted.resolve();
      await this.releaseFirst.promise;
    }
    return { outcome: "completed", finishReason: "stop" };
  }

  release(): void {
    this.releaseFirst.resolve();
  }
}

function sequentialMessageIds(): () => string {
  let index = 0;
  return () => `assistant-${++index}`;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

class HandoffRunner implements StepRunner {
  readonly calls: StepStart[] = [];
  readonly intakeStarted = deferred<void>();
  private readonly releaseIntake = deferred<void>();

  async run(step: StepStart): Promise<StepRunnerResult> {
    this.calls.push(step);
    if (step.turnId === TEST_TURN_ID && step.agentId === "general") {
      return {
        outcome: "completed",
        finishReason: "stop",
        handoff: { toAgentId: "intake", task: "整理资料" },
      };
    }
    if (step.turnId === TEST_TURN_ID && step.agentId === "intake") {
      this.intakeStarted.resolve();
      await this.releaseIntake.promise;
      return { outcome: "completed", finishReason: "stop" };
    }
    return { outcome: "completed", finishReason: "stop" };
  }

  releaseIntakeStep(): void {
    this.releaseIntake.resolve();
  }
}

class AbortableHandoffRunner implements StepRunner {
  readonly calls: StepStart[] = [];
  readonly intakeStarted = deferred<void>();

  async run(
    step: StepStart,
    _context: StepRunContext,
    signal: AbortSignal,
  ): Promise<StepRunnerResult> {
    this.calls.push(step);
    if (step.turnId === TEST_TURN_ID && step.agentId === "general") {
      return {
        outcome: "completed",
        finishReason: "stop",
        handoff: { toAgentId: "intake", task: "整理资料" },
      };
    }
    if (step.turnId === TEST_TURN_ID && step.agentId === "intake") {
      this.intakeStarted.resolve();
      await waitForAbort(signal);
      return { outcome: "aborted" };
    }
    return { outcome: "completed", finishReason: "stop" };
  }
}

class BlockingTurnExecutor implements TurnExecutor {
  readonly starts: TurnStart[] = [];
  private readonly runs = new Map<string, Deferred<TurnFinish>>();

  run(turn: TurnStart, _runtime: TurnRunContext): Promise<TurnFinish> {
    this.starts.push(turn);
    const run = deferred<TurnFinish>();
    this.runs.set(turn.turnId, run);
    return run.promise;
  }

  finish(id: TurnId, finish: TurnFinish): void {
    const run = this.runs.get(id);
    if (run === undefined) throw new Error(`Turn 未启动：${id}`);
    run.resolve(finish);
  }
}

class FakeCompactor implements SessionCompactor {
  readonly requests: SessionCompactionRequest[] = [];

  async compact(request: SessionCompactionRequest): Promise<ManualCompactionResult> {
    this.requests.push(request);
    return { status: "compacted" };
  }
}

function createSessionRuntime() {
  const journal = new MemorySessionJournal();
  const executor = new SessionTurnExecutor({
    journal,
    stepExecutor: new SessionStepExecutor({ journal, runner: new StopRunner() }),
    createMessageId: sequentialMessageIds(),
  });
  const runtime = new SessionRuntime({
    journal,
    executor,
    createTurnId: () => TEST_TURN_ID_2,
  });
  return { journal, runtime };
}

function submitUser(
  runtime: SessionRuntime,
  messageId: string,
  turnRuntime: TurnRunContext = TEST_TURN_RUNTIME,
) {
  return runtime.submit({
    sessionId: TEST_SESSION_ID,
    source: "user",
    agentId: "general",
    input: userMessage(messageId),
    runtime: turnRuntime,
  });
}

describe("SessionRuntime", () => {
  it("submits a turn and exposes the journal projection", async () => {
    const { journal, runtime } = createSessionRuntime();

    await expect(submitUser(runtime, "turn-1")).resolves.toEqual({
      turnId: TEST_TURN_ID,
      position: 0,
    });
    await runtime.waitForIdle(TEST_SESSION_ID);

    const snapshot = await runtime.snapshot(TEST_SESSION_ID);
    expect(snapshot.turns[0]).toMatchObject({
      turnId: TEST_TURN_ID,
      status: "completed",
      finishReason: "completed",
    });
    expect(snapshot.steps[0]).toMatchObject({
      agentId: "general",
      status: "completed",
    });
    expect(await runtime.events(TEST_SESSION_ID)).toHaveLength(5);
    expect((await journal.readAfter(TEST_SESSION_ID, 0)).at(-1)?.event.type).toBe("turn-finished");
  });

  it("keeps each queued turn's runtime context", async () => {
    const journal = new MemorySessionJournal();
    const runner = new TokenRecordingRunner();
    const executor = new SessionTurnExecutor({
      journal,
      stepExecutor: new SessionStepExecutor({ journal, runner }),
      createMessageId: sequentialMessageIds(),
    });
    const runtime = new SessionRuntime({ journal, executor });

    await submitUser(runtime, "turn-1", {
      getAccessToken: async () => "token-1",
    });
    await runner.firstStarted.promise;
    await submitUser(runtime, "turn-2", {
      getAccessToken: async () => "token-2",
    });

    runner.release();
    await runtime.waitForIdle(TEST_SESSION_ID);

    expect(runner.tokens).toEqual(["token-1", "token-2"]);
  });

  it("finishes a handoff chain before starting a queued user turn", async () => {
    const journal = new MemorySessionJournal();
    const runner = new HandoffRunner();
    const executor = new SessionTurnExecutor({
      journal,
      stepExecutor: new SessionStepExecutor({ journal, runner }),
      createMessageId: sequentialMessageIds(),
    });
    const runtime = new SessionRuntime({ journal, executor });

    await submitUser(runtime, "turn-1");
    await runner.intakeStarted.promise;
    await expect(submitUser(runtime, "turn-2")).resolves.toEqual({
      turnId: TEST_TURN_ID_2,
      position: 1,
    });

    expect((await runtime.snapshot(TEST_SESSION_ID)).queue).toEqual([TEST_TURN_ID_2]);
    expect(runner.calls.map((step) => step.turnId)).toEqual([TEST_TURN_ID, TEST_TURN_ID]);

    runner.releaseIntakeStep();
    await runtime.waitForIdle(TEST_SESSION_ID);

    const snapshot = await runtime.snapshot(TEST_SESSION_ID);
    expect(snapshot.turns).toMatchObject([
      { turnId: TEST_TURN_ID, status: "completed" },
      { turnId: TEST_TURN_ID_2, status: "completed" },
    ]);
    expect(runner.calls.map((step) => step.turnId)).toEqual([
      TEST_TURN_ID,
      TEST_TURN_ID,
      TEST_TURN_ID_2,
    ]);

    const events = await runtime.events(TEST_SESSION_ID);
    const handoffIndex = events.findIndex((event) => event.event.type === "turn-handoff");
    const finishedIndex = events.findIndex(
      (event) => event.event.type === "turn-finished" && event.turnId === TEST_TURN_ID,
    );
    const nextStartedIndex = events.findIndex(
      (event) => event.event.type === "turn-started" && event.turnId === TEST_TURN_ID_2,
    );
    expect(handoffIndex).toBeGreaterThan(-1);
    expect(nextStartedIndex).toBeGreaterThan(finishedIndex);
    expect(events.filter((event) => event.event.type === "turn-queued")).toMatchObject([
      { turnId: TEST_TURN_ID },
      { turnId: TEST_TURN_ID_2 },
    ]);
  });

  it("cancels the whole handoff chain and keeps the queued user turn", async () => {
    const journal = new MemorySessionJournal();
    const runner = new AbortableHandoffRunner();
    const executor = new SessionTurnExecutor({
      journal,
      stepExecutor: new SessionStepExecutor({ journal, runner }),
      createMessageId: sequentialMessageIds(),
    });
    const runtime = new SessionRuntime({ journal, executor });

    await submitUser(runtime, "turn-1");
    await runner.intakeStarted.promise;
    await submitUser(runtime, "turn-2");
    await runtime.cancel(TEST_SESSION_ID, TEST_TURN_ID);
    await runtime.waitForIdle(TEST_SESSION_ID);

    const snapshot = await runtime.snapshot(TEST_SESSION_ID);
    expect(snapshot.turns).toMatchObject([
      { turnId: TEST_TURN_ID, status: "aborted", finishReason: "cancelled" },
      { turnId: TEST_TURN_ID_2, status: "completed" },
    ]);
    expect(runner.calls.map((step) => [step.turnId, step.agentId])).toEqual([
      [TEST_TURN_ID, "general"],
      [TEST_TURN_ID, "intake"],
      [TEST_TURN_ID_2, "general"],
    ]);
  });

  it("cancels a queued turn without interrupting the active turn", async () => {
    const journal = new MemorySessionJournal();
    const executor = new BlockingTurnExecutor();
    const runtime = new SessionRuntime({ journal, executor });

    await submitUser(runtime, "turn-1");
    await submitUser(runtime, "turn-2");
    await runtime.cancel(TEST_SESSION_ID, TEST_TURN_ID_2);

    expect((await runtime.snapshot(TEST_SESSION_ID)).turns[1]).toMatchObject({
      status: "aborted",
      finishReason: "cancelled",
    });
    expect((await runtime.snapshot(TEST_SESSION_ID)).activeTurnId).toBe(TEST_TURN_ID);

    executor.finish(TEST_TURN_ID, {
      turnId: TEST_TURN_ID,
      outcome: "completed",
      reason: "completed",
    });
    await runtime.waitForIdle(TEST_SESSION_ID);
  });

  it("closes interrupted facts and resumes queued turns on recovery", async () => {
    const { journal, runtime } = createSessionRuntime();
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

    const plan = await runtime.recover(TEST_SESSION_ID, TEST_TURN_RUNTIME);

    expect(plan.interruptedTurnIds).toEqual([TEST_TURN_ID]);
    expect(plan.interruptedStepIds).toEqual([TEST_STEP_ID]);
    expect(plan.interruptedCompactionIds).toEqual(["operation-1"]);

    await runtime.waitForIdle(TEST_SESSION_ID);
    const snapshot = await runtime.snapshot(TEST_SESSION_ID);
    expect(snapshot.turns[0]).toMatchObject({
      status: "failed",
      finishReason: "interrupted",
      errorText: "Session 恢复时发现 Turn 未完成",
    });
    expect(snapshot.steps[0]).toMatchObject({
      status: "failed",
      finishReason: "error",
      errorText: "Session 恢复时发现 Step 未完成",
    });
    expect(snapshot.compactions[0]).toMatchObject({
      state: "failed",
      errorText: "Session 恢复时发现压缩未完成",
    });
    expect(snapshot.turns[1]).toMatchObject({
      turnId: TEST_TURN_ID_2,
      status: "completed",
    });
  });

  it("does not recover a session that already started", async () => {
    const { runtime } = createSessionRuntime();
    await submitUser(runtime, "turn-1");
    await runtime.waitForIdle(TEST_SESSION_ID);

    await expect(runtime.recover(TEST_SESSION_ID, TEST_TURN_RUNTIME)).rejects.toThrow(
      "不能执行启动恢复",
    );
  });

  it("delegates manual compaction without creating a turn", async () => {
    const journal = new MemorySessionJournal();
    const compactor = new FakeCompactor();
    const runtime = new SessionRuntime({
      journal,
      executor: new BlockingTurnExecutor(),
      compactor,
    });

    await expect(runtime.compact(TEST_SESSION_ID, { operationId: "operation-1" })).resolves.toEqual(
      { status: "compacted" },
    );

    expect(compactor.requests).toMatchObject([{ operationId: "operation-1" }]);
    expect((await runtime.snapshot(TEST_SESSION_ID)).turns).toEqual([]);
  });
});

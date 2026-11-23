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
import { SessionItemRecorder } from "../../../src/core/session/itemRecorder";
import { SessionFrameBus } from "../../../src/core/session/sessionFrameBus";
import { SessionRuntime } from "../../../src/core/session/sessionRuntime";
import { SessionStepExecutor } from "../../../src/core/session/stepExecutor";
import { SessionTurnExecutor } from "../../../src/core/session/turnExecutor";
import type { SessionItemStore } from "../../../src/core/transcript/itemStore";
import type { MemoryConversationStore } from "../../../src/core/transcript/memoryStore";
import {
  createSessionFixture,
  TEST_SESSION_ID,
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

interface Harness {
  store: MemoryConversationStore;
  items: SessionItemStore;
  runtime: SessionRuntime;
}

async function harnessWith(
  options: {
    stepRunner?: StepRunner;
    executor?: TurnExecutor;
    compactor?: SessionCompactor;
    createMessageId?: () => string;
  } = {},
): Promise<Harness> {
  const { store, items } = await createSessionFixture();
  const recorder = new SessionItemRecorder({ items, store, frames: new SessionFrameBus() });
  const executor =
    options.executor ??
    new SessionTurnExecutor({
      recorder,
      stepExecutor: new SessionStepExecutor({
        recorder,
        runner: options.stepRunner ?? new StopRunner(),
      }),
      createMessageId: options.createMessageId ?? sequentialMessageIds(),
    });
  const runtime = new SessionRuntime({
    items,
    store,
    recorder,
    executor,
    defaults: { agentId: "general", source: "user" },
    createTurnId: () => TEST_TURN_ID_2,
    createMessageId: () => "assistant-message",
    ...(options.compactor === undefined ? {} : { compactor: options.compactor }),
  });
  return { store, items, runtime };
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

async function appendUserItem(
  items: SessionItemStore,
  turnId: string,
  createdAt: string,
): Promise<void> {
  await items.appendItems(TEST_SESSION_ID, [
    {
      itemId: turnId,
      status: "complete",
      createdAt,
      turnId,
      payload: { kind: "user", text: "hello", images: [] },
    },
  ]);
}

describe("SessionRuntime", () => {
  it("submits a turn and exposes the item projection", async () => {
    const { runtime } = await harnessWith();

    await expect(submitUser(runtime, "turn-1")).resolves.toEqual({
      turnId: TEST_TURN_ID,
      messageId: "assistant-message",
      position: 0,
    });
    await runtime.waitForIdle(TEST_SESSION_ID);

    const snapshot = await runtime.snapshot(TEST_SESSION_ID);
    expect(snapshot.turns[0]).toMatchObject({
      turnId: TEST_TURN_ID,
      status: "completed",
      finishReason: "completed",
    });
    const frames = await runtime.readFramesAfter(TEST_SESSION_ID, 0);
    expect(frames.map((frame) => frame.event.type)).toEqual(frames.map(() => "session-item"));
    expect(frames.at(-1)?.event).toMatchObject({
      type: "session-item",
      item: { payload: { kind: "turn-end" }, turnId: TEST_TURN_ID },
    });
  });

  it("keeps each queued turn's runtime context", async () => {
    const runner = new TokenRecordingRunner();
    const { runtime } = await harnessWith({ stepRunner: runner });

    await submitUser(runtime, "turn-1", { getAccessToken: async () => "token-1" });
    await runner.firstStarted.promise;
    await submitUser(runtime, "turn-2", { getAccessToken: async () => "token-2" });

    runner.release();
    await runtime.waitForIdle(TEST_SESSION_ID);

    expect(runner.tokens).toEqual(["token-1", "token-2"]);
  });

  it("finishes a handoff chain before starting a queued user turn", async () => {
    const runner = new HandoffRunner();
    const { runtime, items } = await harnessWith({ stepRunner: runner });

    await submitUser(runtime, "turn-1");
    await runner.intakeStarted.promise;
    await expect(submitUser(runtime, "turn-2")).resolves.toEqual({
      turnId: TEST_TURN_ID_2,
      messageId: "assistant-message",
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

    const written = await items.readItems(TEST_SESSION_ID);
    const handoff = written.find((item) => item.audienceAgentId === "intake");
    const turnEnd = written.find((item) => item.itemId === `${TEST_TURN_ID}:end`);
    expect(handoff).toMatchObject({
      payload: { kind: "text", text: "整理资料" },
      authorAgentId: "general",
    });
    expect(turnEnd?.seq).toBeGreaterThan(handoff?.seq ?? 0);
    // 排队用户的用户条目在提交时即落库，可能早于上一 Turn 的收口；这里只确认它存在且归属正确。
    const secondUser = written.find(
      (item) => item.payload.kind === "user" && item.turnId === TEST_TURN_ID_2,
    );
    expect(secondUser?.itemId).toBe("turn-2");
  });

  it("cancels the whole handoff chain and keeps the queued user turn", async () => {
    const runner = new AbortableHandoffRunner();
    const { runtime } = await harnessWith({ stepRunner: runner });

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
    const executor = new BlockingTurnExecutor();
    const { runtime } = await harnessWith({ executor });

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

  it("closes interrupted turns and resumes queued turns on recovery", async () => {
    const { store, items } = await createSessionFixture();
    await appendUserItem(items, "turn-1", "2026-11-23T10:00:00.000Z");
    await items.beginTurn(TEST_SESSION_ID, "turn-1");
    await items.appendItems(TEST_SESSION_ID, [
      {
        itemId: "text-1",
        status: "complete",
        createdAt: "2026-11-23T10:00:01.000Z",
        turnId: "turn-1",
        messageId: "assistant-1",
        authorAgentId: "general",
        payload: { kind: "text", text: "半截回复" },
      },
    ]);
    await appendUserItem(items, "turn-2", "2026-11-23T10:00:02.000Z");
    const recorder = new SessionItemRecorder({ items, store, frames: new SessionFrameBus() });
    const executor = new SessionTurnExecutor({
      recorder,
      stepExecutor: new SessionStepExecutor({ recorder, runner: new StopRunner() }),
      createMessageId: sequentialMessageIds(),
    });
    const runtime = new SessionRuntime({
      items,
      store,
      recorder,
      executor,
      defaults: { agentId: "general", source: "user" },
      createTurnId: () => TEST_TURN_ID_2,
      createMessageId: () => "assistant-message",
    });

    const plan = await runtime.recoverFacts(TEST_SESSION_ID);
    await runtime.refreshTranscript(TEST_SESSION_ID);
    await runtime.resumeQueued(TEST_SESSION_ID, TEST_TURN_RUNTIME);

    expect(plan.closedTurnIds).toEqual([TEST_TURN_ID]);
    expect(plan.pendingTurnIds).toEqual([TEST_TURN_ID_2]);

    await runtime.waitForIdle(TEST_SESSION_ID);
    const snapshot = await runtime.snapshot(TEST_SESSION_ID);
    expect(snapshot.turns[0]).toMatchObject({
      status: "aborted",
      finishReason: "interrupted",
    });
    expect(snapshot.turns[1]).toMatchObject({
      turnId: TEST_TURN_ID_2,
      status: "completed",
    });
  });

  it("does not recover a session that already started", async () => {
    const { runtime } = await harnessWith();
    await submitUser(runtime, "turn-1");
    await runtime.waitForIdle(TEST_SESSION_ID);

    await expect(runtime.resumeQueued(TEST_SESSION_ID, TEST_TURN_RUNTIME)).rejects.toThrow(
      "不能执行启动恢复",
    );
  });

  it("delegates manual compaction without creating a turn", async () => {
    const compactor = new FakeCompactor();
    const { runtime } = await harnessWith({
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

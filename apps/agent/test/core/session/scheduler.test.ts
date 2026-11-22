import type { ManualCompactionResult } from "@answra/shared/schema";
import { describe, expect, it } from "vitest";
import type {
  SessionCompactionRequest,
  SessionCompactor,
  TurnExecutor,
  TurnFinish,
  TurnId,
  TurnRunContext,
  TurnStart,
} from "../../../src/core/session/contracts";
import { MemorySessionJournal } from "../../../src/core/session/memoryJournal";
import { TurnScheduler } from "../../../src/core/session/scheduler";
import {
  TEST_SESSION_ID,
  TEST_TURN_ID,
  TEST_TURN_ID_2,
  TEST_TURN_RUNTIME,
  userMessage,
} from "./fixtures";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveResult, rejectResult) => {
    resolve = resolveResult;
    reject = rejectResult;
  });
  return { promise, resolve, reject };
}

class FakeTurnExecutor implements TurnExecutor {
  readonly starts: TurnStart[] = [];
  readonly runtimes: TurnRunContext[] = [];
  private readonly runs = new Map<string, Deferred<TurnFinish>>();
  private readonly starters = new Map<string, Deferred<TurnStart>>();

  run(turn: TurnStart, runtime: TurnRunContext, signal: AbortSignal): Promise<TurnFinish> {
    this.starts.push(turn);
    this.runtimes.push(runtime);
    const run = deferred<TurnFinish>();
    this.runs.set(turn.turnId, run);
    this.starters.get(turn.turnId)?.resolve(turn);
    if (signal.aborted) {
      run.resolve({ turnId: turn.turnId, outcome: "aborted", reason: "cancelled" });
    } else {
      signal.addEventListener(
        "abort",
        () => {
          run.resolve({ turnId: turn.turnId, outcome: "aborted", reason: "cancelled" });
        },
        { once: true },
      );
    }
    return run.promise;
  }

  started(id: TurnId): Promise<TurnStart> {
    const started = this.starts.find((turn) => turn.turnId === id);
    if (started !== undefined) return Promise.resolve(started);
    const waiter = deferred<TurnStart>();
    this.starters.set(id, waiter);
    return waiter.promise;
  }

  finish(id: TurnId, finish: TurnFinish): void {
    const run = this.runs.get(id);
    if (run === undefined) throw new Error(`Turn 未启动：${id}`);
    run.resolve(finish);
  }
}

class FakeCompactor implements SessionCompactor {
  readonly requests: SessionCompactionRequest[] = [];
  private readonly runs = new Map<string, Deferred<ManualCompactionResult>>();
  private readonly starters = new Map<string, Deferred<SessionCompactionRequest>>();

  compact(
    request: SessionCompactionRequest,
    _signal: AbortSignal,
  ): Promise<ManualCompactionResult> {
    this.requests.push(request);
    const run = deferred<ManualCompactionResult>();
    this.runs.set(request.operationId, run);
    this.starters.get(request.operationId)?.resolve(request);
    return run.promise;
  }

  started(operationId: string): Promise<SessionCompactionRequest> {
    const started = this.requests.find((request) => request.operationId === operationId);
    if (started !== undefined) return Promise.resolve(started);
    const waiter = deferred<SessionCompactionRequest>();
    this.starters.set(operationId, waiter);
    return waiter.promise;
  }

  finish(operationId: string, result: ManualCompactionResult): void {
    const run = this.runs.get(operationId);
    if (run === undefined) throw new Error(`压缩未启动：${operationId}`);
    run.resolve(result);
  }
}

async function createScheduler(compactor?: SessionCompactor) {
  const journal = new MemorySessionJournal();
  const executor = new FakeTurnExecutor();
  const scheduler = await TurnScheduler.create({
    sessionId: TEST_SESSION_ID,
    journal,
    executor,
    ...(compactor === undefined ? {} : { compactor }),
    createTurnId: () => TEST_TURN_ID_2,
    createOperationId: () => "generated-operation",
    createMessageId: () => "assistant-message",
  });
  return { journal, executor, scheduler };
}

function submitUser(scheduler: TurnScheduler, messageId: string) {
  return scheduler.submit({
    sessionId: TEST_SESSION_ID,
    source: "user",
    agentId: "general",
    input: userMessage(messageId),
    runtime: TEST_TURN_RUNTIME,
  });
}

describe("TurnScheduler", () => {
  it("starts the first submitted turn and queues the next in FIFO order", async () => {
    const { scheduler, executor } = await createScheduler();

    await expect(submitUser(scheduler, "turn-1")).resolves.toEqual({
      turnId: TEST_TURN_ID,
      messageId: "assistant-message",
      position: 0,
    });
    await expect(submitUser(scheduler, "turn-2")).resolves.toEqual({
      turnId: TEST_TURN_ID_2,
      messageId: "assistant-message",
      position: 1,
    });

    expect(scheduler.snapshot()).toMatchObject({
      activeTurnId: TEST_TURN_ID,
      queue: [TEST_TURN_ID_2],
    });
    await executor.started(TEST_TURN_ID);
    expect(executor.starts.map((turn) => turn.turnId)).toEqual([TEST_TURN_ID]);
  });

  it("starts the next queued turn only after the active turn completes", async () => {
    const { scheduler, executor } = await createScheduler();
    await submitUser(scheduler, "turn-1");
    await submitUser(scheduler, "turn-2");

    executor.finish(TEST_TURN_ID, {
      turnId: TEST_TURN_ID,
      outcome: "completed",
      reason: "completed",
    });
    await executor.started(TEST_TURN_ID_2);

    expect(scheduler.snapshot().turns[0]).toMatchObject({ status: "completed" });
    expect(scheduler.snapshot().turns[1]).toMatchObject({ status: "running" });

    executor.finish(TEST_TURN_ID_2, {
      turnId: TEST_TURN_ID_2,
      outcome: "completed",
      reason: "completed",
    });
    await scheduler.waitForIdle();

    expect(scheduler.snapshot().activeTurnId).toBeUndefined();
    expect(scheduler.snapshot().queue).toEqual([]);
  });

  it("keeps the queue moving when a turn fails", async () => {
    const { scheduler, executor } = await createScheduler();
    await submitUser(scheduler, "turn-1");
    await submitUser(scheduler, "turn-2");

    executor.finish(TEST_TURN_ID, {
      turnId: TEST_TURN_ID,
      outcome: "failed",
      reason: "model-error",
    });
    await executor.started(TEST_TURN_ID_2);

    expect(scheduler.snapshot().turns[0]).toMatchObject({
      status: "failed",
      finishReason: "model-error",
    });

    executor.finish(TEST_TURN_ID_2, {
      turnId: TEST_TURN_ID_2,
      outcome: "completed",
      reason: "completed",
    });
    await scheduler.waitForIdle();
  });

  it("cancels a queued turn without interrupting the active turn", async () => {
    const { scheduler, executor } = await createScheduler();
    await submitUser(scheduler, "turn-1");
    await submitUser(scheduler, "turn-2");

    await scheduler.cancel(TEST_TURN_ID_2);

    expect(scheduler.snapshot().queue).toEqual([]);
    expect(scheduler.snapshot().activeTurnId).toBe(TEST_TURN_ID);
    expect(scheduler.snapshot().turns[1]).toMatchObject({
      status: "aborted",
      finishReason: "cancelled",
    });

    executor.finish(TEST_TURN_ID, {
      turnId: TEST_TURN_ID,
      outcome: "completed",
      reason: "completed",
    });
    await scheduler.waitForIdle();
  });

  it("aborts the active turn and starts the next queued turn", async () => {
    const { scheduler, executor } = await createScheduler();
    await submitUser(scheduler, "turn-1");
    await submitUser(scheduler, "turn-2");

    await scheduler.cancel(TEST_TURN_ID);
    await executor.started(TEST_TURN_ID_2);

    expect(scheduler.snapshot().turns[0]).toMatchObject({ status: "aborted" });
    expect(scheduler.snapshot().turns[1]).toMatchObject({ status: "running" });

    executor.finish(TEST_TURN_ID_2, {
      turnId: TEST_TURN_ID_2,
      outcome: "completed",
      reason: "completed",
    });
    await scheduler.waitForIdle();
  });

  it("cancels queued turns when cancelling the active turn requests it", async () => {
    const { scheduler } = await createScheduler();
    await submitUser(scheduler, "turn-1");
    await submitUser(scheduler, "turn-2");

    await scheduler.cancel(TEST_TURN_ID, { cancelQueued: true });
    await scheduler.waitForIdle();

    expect(scheduler.snapshot().turns).toMatchObject([
      { status: "aborted" },
      { status: "aborted" },
    ]);
    expect(scheduler.snapshot().queue).toEqual([]);
  });

  it("runs a requested compaction after the active turn and before the next queued turn", async () => {
    const compactor = new FakeCompactor();
    const { scheduler, executor } = await createScheduler(compactor);
    await submitUser(scheduler, "turn-1");
    await submitUser(scheduler, "turn-2");

    const compaction = scheduler.requestCompaction({ operationId: "operation-1" });
    executor.finish(TEST_TURN_ID, {
      turnId: TEST_TURN_ID,
      outcome: "completed",
      reason: "completed",
    });
    await compactor.started("operation-1");

    expect(executor.starts.map((turn) => turn.turnId)).toEqual([TEST_TURN_ID]);
    expect(scheduler.snapshot().queue).toEqual([TEST_TURN_ID_2]);

    compactor.finish("operation-1", { status: "compacted" });
    await executor.started(TEST_TURN_ID_2);
    await expect(compaction).resolves.toEqual({ status: "compacted" });

    executor.finish(TEST_TURN_ID_2, {
      turnId: TEST_TURN_ID_2,
      outcome: "completed",
      reason: "completed",
    });
    await scheduler.waitForIdle();
  });

  it("runs manual compaction without creating a turn", async () => {
    const compactor = new FakeCompactor();
    const { scheduler } = await createScheduler(compactor);

    const compaction = scheduler.requestCompaction({ operationId: "operation-1" });
    await compactor.started("operation-1");
    expect(scheduler.snapshot().turns).toEqual([]);

    compactor.finish("operation-1", { status: "compacted" });
    await expect(compaction).resolves.toEqual({ status: "compacted" });
    await scheduler.waitForIdle();
    expect(scheduler.snapshot().turns).toEqual([]);
  });

  it("cancels a manual compaction when the host signal aborts", async () => {
    const compactor: SessionCompactor = {
      compact: (_request, signal) =>
        new Promise((resolve) => {
          if (signal.aborted) {
            resolve({ status: "failed", errorText: "已取消" });
            return;
          }
          signal.addEventListener(
            "abort",
            () => resolve({ status: "failed", errorText: "已取消" }),
            {
              once: true,
            },
          );
        }),
    };
    const { scheduler } = await createScheduler(compactor);
    const controller = new AbortController();

    const compaction = scheduler.requestCompaction({
      operationId: "operation-1",
      signal: controller.signal,
    });
    controller.abort();

    await expect(compaction).resolves.toEqual({ status: "failed", errorText: "已取消" });
    await scheduler.waitForIdle();
  });

  it("resumes queued turns from the journal", async () => {
    const journal = new MemorySessionJournal();
    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-queued", source: "user", input: userMessage("turn-1"), agentId: "general" },
      { turnId: TEST_TURN_ID },
    );
    await journal.append(
      TEST_SESSION_ID,
      {
        type: "turn-queued",
        source: "user",
        input: userMessage("turn-2"),
        agentId: "general",
      },
      { turnId: TEST_TURN_ID_2 },
    );
    const executor = new FakeTurnExecutor();
    const scheduler = await TurnScheduler.create({
      sessionId: TEST_SESSION_ID,
      journal,
      executor,
    });

    expect(executor.starts).toEqual([]);
    await scheduler.resume(TEST_TURN_RUNTIME);
    await executor.started(TEST_TURN_ID);

    expect(executor.runtimes).toEqual([TEST_TURN_RUNTIME]);
    expect(scheduler.snapshot().queue).toEqual([TEST_TURN_ID_2]);
  });

  it("resolves waits for a terminal turn rebuilt from the journal", async () => {
    const journal = new MemorySessionJournal();
    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-queued", source: "user", input: userMessage("turn-1"), agentId: "general" },
      { turnId: TEST_TURN_ID },
    );
    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-started", agentId: "general" },
      { turnId: TEST_TURN_ID, messageId: "assistant-1" },
    );
    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-finished", status: "failed", reason: "interrupted", errorText: "中断" },
      { turnId: TEST_TURN_ID },
    );
    const scheduler = await TurnScheduler.create({
      sessionId: TEST_SESSION_ID,
      journal,
      executor: new FakeTurnExecutor(),
    });

    await expect(scheduler.waitForTurn(TEST_TURN_ID)).resolves.toEqual({
      messageId: "assistant-1",
      outcome: "failed",
      errorText: "中断",
    });
    await expect(scheduler.waitForTurnStart(TEST_TURN_ID)).resolves.toBe("assistant-1");
  });

  it("resolves a cancelled queued turn without waiting for a scheduler that will never start it", async () => {
    const journal = new MemorySessionJournal();
    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-queued", source: "user", input: userMessage("turn-2"), agentId: "general" },
      { turnId: TEST_TURN_ID_2 },
    );
    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-finished", status: "aborted", reason: "cancelled" },
      { turnId: TEST_TURN_ID_2 },
    );
    const scheduler = await TurnScheduler.create({
      sessionId: TEST_SESSION_ID,
      journal,
      executor: new FakeTurnExecutor(),
    });

    await expect(scheduler.waitForTurn(TEST_TURN_ID_2)).resolves.toEqual({ outcome: "aborted" });
    await expect(scheduler.waitForTurnStart(TEST_TURN_ID_2)).rejects.toThrow(
      "Turn 已结束且没有 assistant 消息",
    );
  });

  it("refuses to start unrecovered queued turns without a runtime", async () => {
    const journal = new MemorySessionJournal();
    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-queued", source: "user", input: userMessage("turn-1"), agentId: "general" },
      { turnId: TEST_TURN_ID },
    );
    const executor = new FakeTurnExecutor();
    const scheduler = await TurnScheduler.create({
      sessionId: TEST_SESSION_ID,
      journal,
      executor,
    });

    await expect(submitUser(scheduler, "turn-2")).rejects.toThrow("queued Turn 缺少运行时上下文");
    expect(executor.starts).toEqual([]);
  });

  it("does not retry a turn that was already running before resume", async () => {
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
        type: "turn-queued",
        source: "user",
        input: userMessage("turn-2"),
        agentId: "general",
      },
      { turnId: TEST_TURN_ID_2 },
    );
    const executor = new FakeTurnExecutor();
    const scheduler = await TurnScheduler.create({
      sessionId: TEST_SESSION_ID,
      journal,
      executor,
    });

    await scheduler.resume(TEST_TURN_RUNTIME);

    expect(executor.starts).toEqual([]);
    expect(scheduler.snapshot().activeTurnId).toBe(TEST_TURN_ID);
    expect(scheduler.snapshot().queue).toEqual([TEST_TURN_ID_2]);
  });
});

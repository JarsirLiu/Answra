/** Session 运行时门面：按 session 组装 journal 与 scheduler，不复制 turn/queue 状态。 */
import { randomUUID } from "node:crypto";
import type {
  ManualCompactionResult,
  SessionEventEnvelope,
  TurnOutcome,
} from "@answra/shared/schema";
import type {
  CancelTurnOptions,
  SessionCompactor,
  SessionId,
  SessionProjection,
  SessionRecoveryPlan,
  TurnExecutor,
  TurnId,
  TurnRunContext,
  TurnSubmission,
  TurnSubmissionResult,
} from "./contracts";
import { turnId } from "./contracts";
import type { SessionJournal } from "./journal";
import { projectSession } from "./projection";
import { recoverSession } from "./recovery";
import { type ManualCompactionRequest, TurnScheduler } from "./scheduler";

export interface SessionRuntimeOptions {
  journal: SessionJournal;
  executor: TurnExecutor;
  compactor?: SessionCompactor;
  createTurnId?: () => TurnId;
  createOperationId?: () => string;
  /** 首条 assistant 消息 id 由 transcript 宿主提供。 */
  createMessageId?: () => string;
}

export class SessionRuntime {
  private readonly journal: SessionJournal;
  private readonly executor: TurnExecutor;
  private readonly compactor?: SessionCompactor;
  private readonly createTurnId: () => TurnId;
  private readonly createOperationId: () => string;
  private readonly createMessageId?: () => string;
  private readonly schedulers = new Map<SessionId, Promise<TurnScheduler>>();
  private readonly readySchedulers = new Map<SessionId, TurnScheduler>();

  constructor(options: SessionRuntimeOptions) {
    this.journal = options.journal;
    this.executor = options.executor;
    this.compactor = options.compactor;
    this.createTurnId = options.createTurnId ?? (() => turnId(randomUUID()));
    this.createOperationId = options.createOperationId ?? randomUUID;
    this.createMessageId = options.createMessageId;
  }

  async submit(submission: TurnSubmission): Promise<TurnSubmissionResult> {
    const scheduler = await this.scheduler(submission.sessionId);
    return scheduler.submit(submission);
  }

  async cancel(
    sessionId: SessionId,
    target: TurnId,
    options: CancelTurnOptions = {},
  ): Promise<void> {
    const scheduler = await this.scheduler(sessionId);
    await scheduler.cancel(target, options);
  }

  async compact(
    sessionId: SessionId,
    request: ManualCompactionRequest = {},
  ): Promise<ManualCompactionResult> {
    const scheduler = await this.scheduler(sessionId);
    return scheduler.requestCompaction(request);
  }

  async snapshot(sessionId: SessionId): Promise<SessionProjection> {
    const events = await this.journal.readAfter(sessionId, 0);
    return projectSession(sessionId, events);
  }

  events(sessionId: SessionId, after = 0): Promise<SessionEventEnvelope[]> {
    return this.journal.readAfter(sessionId, after);
  }

  /** 只写回崩溃遗留事实；不创建 Scheduler，也不会启动 queued Turn。 */
  recoverFacts(sessionId: SessionId): Promise<SessionRecoveryPlan> {
    return recoverSession(this.journal, sessionId);
  }

  /**
   * transcript 写回完成后才继续消费 queued Turn。
   * 顺序不能颠倒：Scheduler 一启动就会读 transcript 写 assistant 消息，
   * 早于 bridge 恢复 queued 输入会让用户消息整条丢失。
   */
  async resumeQueued(sessionId: SessionId, runtime: TurnRunContext): Promise<void> {
    if (this.schedulers.has(sessionId)) {
      throw new Error(`会话已启动，不能执行启动恢复：${sessionId}`);
    }
    const scheduler = await this.scheduler(sessionId);
    await scheduler.resume(runtime);
  }

  /** 等待 Turn 启动并返回首条 assistant 消息 id；renderer 以它作为 runId。 */
  async waitForTurnStart(sessionId: SessionId, target: TurnId): Promise<string> {
    const scheduler = await this.scheduler(sessionId);
    return scheduler.waitForTurnStart(target);
  }

  async waitForTurn(
    sessionId: SessionId,
    target: TurnId,
  ): Promise<{ runId?: string; outcome: TurnOutcome; errorText?: string }> {
    const scheduler = await this.scheduler(sessionId);
    return scheduler.waitForTurn(target);
  }

  async runIdFor(sessionId: SessionId, target: TurnId): Promise<string | undefined> {
    const scheduler = await this.scheduler(sessionId);
    return scheduler.runIdFor(target);
  }

  async position(sessionId: SessionId, target: TurnId): Promise<number | undefined> {
    const scheduler = this.schedulers.get(sessionId);
    if (scheduler === undefined) return undefined;
    return (await scheduler).position(target);
  }

  /** 同步读取已创建 scheduler 的队列位置；供 IPC 的同步 position 契约使用。 */
  cachedPosition(sessionId: SessionId, target: TurnId): number | undefined {
    return this.readySchedulers.get(sessionId)?.position(target);
  }

  async queuedCount(sessionId: SessionId): Promise<number> {
    const pending = this.schedulers.get(sessionId);
    if (pending === undefined) return 0;
    return (await pending).queuedCount();
  }

  /** 清空会话前终止活动 Turn 与排队 Turn，但不销毁 scheduler。 */
  async cancelSession(sessionId: SessionId): Promise<void> {
    const pending = this.schedulers.get(sessionId);
    if (pending === undefined) return;
    (await pending).dispose();
  }

  async cancelPending(sessionId: SessionId): Promise<void> {
    const pending = this.schedulers.get(sessionId);
    if (pending === undefined) return;
    await (await pending).cancelPending();
  }

  async busy(sessionId: SessionId): Promise<boolean> {
    const pending = this.schedulers.get(sessionId);
    if (pending === undefined) return false;
    return (await pending).busy();
  }

  dispose(): void {
    for (const pending of this.schedulers.values())
      void pending.then((scheduler) => scheduler.dispose());
    this.schedulers.clear();
    this.readySchedulers.clear();
  }

  /** 退出屏障：中止所有 Turn，等待终态落账后清空调度器；与即时 `dispose` 区分。 */
  async shutdown(): Promise<void> {
    const pending = [...this.schedulers.values()];
    this.schedulers.clear();
    this.readySchedulers.clear();
    const schedulers = await Promise.all(pending);
    for (const scheduler of schedulers) scheduler.dispose();
    await Promise.all(schedulers.map((scheduler) => scheduler.waitForIdle()));
  }

  async waitForIdle(sessionId: SessionId): Promise<void> {
    const pending = this.schedulers.get(sessionId);
    if (pending === undefined) return;
    const scheduler = await pending;
    await scheduler.waitForIdle();
  }

  private scheduler(sessionId: SessionId): Promise<TurnScheduler> {
    const existing = this.schedulers.get(sessionId);
    if (existing !== undefined) return existing;

    const created = TurnScheduler.create({
      sessionId,
      journal: this.journal,
      executor: this.executor,
      ...(this.compactor === undefined ? {} : { compactor: this.compactor }),
      createTurnId: this.createTurnId,
      createOperationId: this.createOperationId,
      ...(this.createMessageId === undefined ? {} : { createMessageId: this.createMessageId }),
    });
    void created.then((scheduler) => this.readySchedulers.set(sessionId, scheduler));
    this.schedulers.set(sessionId, created);
    created.catch(() => {
      if (this.schedulers.get(sessionId) === created) this.schedulers.delete(sessionId);
    });
    return created;
  }
}

/** Session 运行时门面：按 session 组装条目、Turn 快照与 Scheduler，不复制 turn/queue 状态。 */
import { randomUUID } from "node:crypto";
import type { ConversationMessage, ConversationSnapshot } from "@answra/shared";
import type { ManualCompactionResult, SessionFrame, TurnOutcome } from "@answra/shared/schema";
import type { SessionItemStore } from "../transcript/itemStore";
import type { ConversationStore } from "../transcript/store";
import type {
  CancelTurnOptions,
  SessionCompactor,
  SessionId,
  SessionProjection,
  SessionRecoveryPlan,
  TurnExecutor,
  TurnId,
  TurnProjection,
  TurnRunContext,
  TurnSubmission,
  TurnSubmissionResult,
} from "./contracts";
import { turnId } from "./contracts";
import type { SessionItemRecorder } from "./itemRecorder";
import type { ManualCompactionRequest, TurnScheduler } from "./scheduler";
import { TurnScheduler as Scheduler } from "./scheduler";
import { planSessionRecovery, projectSessionTurns, type SessionTurnDefaults } from "./sessionTurns";

export interface SessionRuntimeOptions {
  items: SessionItemStore;
  store: ConversationStore;
  /** 唯一事实写入面；宿主同时把它交给 Step/TurnExecutor。 */
  recorder: SessionItemRecorder;
  executor: TurnExecutor;
  compactor?: SessionCompactor;
  /** 条目里没有 Bot 身份与 Turn 来源；投影与恢复由此补齐。 */
  defaults: SessionTurnDefaults;
  createTurnId?: () => TurnId;
  createOperationId?: () => string;
  createMessageId?: () => string;
  now?: () => Date;
}

export class SessionRuntime {
  private readonly items: SessionItemStore;
  private readonly store: ConversationStore;
  private readonly recorder: SessionItemRecorder;
  private readonly executor: TurnExecutor;
  private readonly compactor?: SessionCompactor;
  private readonly defaults: SessionTurnDefaults;
  private readonly createTurnId: () => TurnId;
  private readonly createOperationId: () => string;
  private readonly createMessageId?: () => string;
  private readonly now: () => Date;
  private readonly schedulers = new Map<SessionId, Promise<TurnScheduler>>();
  private readonly readySchedulers = new Map<SessionId, TurnScheduler>();

  constructor(options: SessionRuntimeOptions) {
    this.items = options.items;
    this.store = options.store;
    this.recorder = options.recorder;
    this.executor = options.executor;
    this.compactor = options.compactor;
    this.defaults = options.defaults;
    this.createTurnId = options.createTurnId ?? (() => turnId(randomUUID()));
    this.createOperationId = options.createOperationId ?? randomUUID;
    this.createMessageId = options.createMessageId;
    this.now = options.now ?? (() => new Date());
  }

  /** 宿主新建会话后初始化条目存储；内存与 SQLite 实现都幂等。 */
  async createSession(sessionId: SessionId): Promise<void> {
    await this.items.create(sessionId);
  }

  async submit(submission: TurnSubmission): Promise<TurnSubmissionResult> {
    const scheduler = await this.scheduler(submission.sessionId);
    return scheduler.submit(submission);
  }

  /** 提交即写 durable 事实；`recordUserMessage` 只在 Turn 真开始时进内存视图。 */
  async appendUserMessage(
    sessionId: SessionId,
    message: ConversationMessage,
  ): Promise<ConversationSnapshot> {
    await this.store.appendUserMessage(sessionId, message);
    await this.recorder.recordStandaloneUserMessage(sessionId, message);
    return this.store.load(sessionId);
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

  /** 已创建的 Scheduler 持有活跃状态；未创建时直接从条目投影。 */
  async snapshot(sessionId: SessionId): Promise<SessionProjection> {
    const pending = this.schedulers.get(sessionId);
    if (pending !== undefined) return (await pending).snapshot();
    return this.project(sessionId);
  }

  /** 按 durable `seq` 读取条目帧；客户端按 `seq` 幂等折叠并补齐缺口。 */
  readFramesAfter(sessionId: SessionId, afterSeq: number): Promise<SessionFrame[]> {
    return this.recorder.readFramesAfter(sessionId, afterSeq);
  }

  lastSequence(sessionId: SessionId): Promise<number> {
    return this.recorder.lastSeq(sessionId);
  }

  /** 只写回崩溃遗留的收口条目；不创建 Scheduler，也不会启动 queued Turn。 */
  async recoverFacts(sessionId: SessionId): Promise<SessionRecoveryPlan> {
    const items = await this.items.readItems(sessionId);
    const plan = planSessionRecovery(items, this.now().toISOString());
    if (plan.closeItems.length > 0) await this.recorder.appendDrafts(sessionId, plan.closeItems);
    return { closedTurnIds: plan.closedTurnIds, pendingTurnIds: plan.pending };
  }

  /** 收口条目写入后用条目重建消息视图；必须早于 queued Turn 续跑。 */
  refreshTranscript(sessionId: SessionId): Promise<void> {
    return this.store.refresh(sessionId);
  }

  /**
   * 条目视图重建完成后才继续消费 queued Turn。
   * 顺序不能颠倒：Scheduler 一启动就会读 transcript 写 assistant 消息，
   * 早于视图重建续跑 queued 输入会让用户消息整条丢失。
   */
  async resumeQueued(sessionId: SessionId, runtime: TurnRunContext): Promise<void> {
    if (this.schedulers.has(sessionId)) {
      throw new Error(`会话已启动，不能执行启动恢复：${sessionId}`);
    }
    const scheduler = await this.scheduler(sessionId);
    await scheduler.resume(runtime);
  }

  /** 等待 Turn 启动并返回首条 assistant 消息 id；取消与渲染都以 Turn 定位。 */
  async waitForTurnStart(sessionId: SessionId, target: TurnId): Promise<string> {
    const scheduler = await this.scheduler(sessionId);
    return scheduler.waitForTurnStart(target);
  }

  async waitForTurn(
    sessionId: SessionId,
    target: TurnId,
  ): Promise<{ messageId?: string; outcome: TurnOutcome; errorText?: string }> {
    const scheduler = await this.scheduler(sessionId);
    return scheduler.waitForTurn(target);
  }

  async messageIdFor(sessionId: SessionId, target: TurnId): Promise<string | undefined> {
    const scheduler = await this.scheduler(sessionId);
    return scheduler.messageIdFor(target);
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

  /**
   * 丢弃会话的 Scheduler 与投影。
   *
   * 清空条目后 `seq` 会从 1 重新开始；保留旧 scheduler 会让投影停止前进，
   * 因此清空必须同时丢弃调度器，下一次 submit 重新从条目建立投影。
   */
  async forget(sessionId: SessionId): Promise<void> {
    const pending = this.schedulers.get(sessionId);
    this.schedulers.delete(sessionId);
    this.readySchedulers.delete(sessionId);
    if (pending === undefined) return;
    (await pending).dispose();
  }

  /** 清空会话的 durable 条目；调用方负责同时清空 transcript 视图与恢复标记。 */
  async clear(sessionId: SessionId): Promise<void> {
    await this.recorder.clear(sessionId);
    await this.forget(sessionId);
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

  private async project(sessionId: SessionId): Promise<SessionProjection> {
    const items = await this.items.readItems(sessionId);
    const cursor = await this.items.readCursor(sessionId);
    const projected = projectSessionTurns(sessionId, items, {
      ...(cursor?.openTurnId === undefined ? {} : { openTurnId: cursor.openTurnId }),
      defaults: this.defaults,
    });
    return {
      sessionId,
      sequence: projected.sequence,
      turns: projected.turns as readonly TurnProjection[],
      queue: projected.pending,
      ...(projected.activeTurnId === undefined ? {} : { activeTurnId: projected.activeTurnId }),
    };
  }

  private scheduler(sessionId: SessionId): Promise<TurnScheduler> {
    const existing = this.schedulers.get(sessionId);
    if (existing !== undefined) return existing;

    const created = Scheduler.create({
      sessionId,
      items: this.items,
      recorder: this.recorder,
      executor: this.executor,
      ...(this.compactor === undefined ? {} : { compactor: this.compactor }),
      defaults: this.defaults,
      createTurnId: this.createTurnId,
      createOperationId: this.createOperationId,
      ...(this.createMessageId === undefined ? {} : { createMessageId: this.createMessageId }),
      now: this.now,
    });
    void created.then((scheduler) => this.readySchedulers.set(sessionId, scheduler));
    this.schedulers.set(sessionId, created);
    created.catch(() => {
      if (this.schedulers.get(sessionId) === created) this.schedulers.delete(sessionId);
    });
    return created;
  }
}

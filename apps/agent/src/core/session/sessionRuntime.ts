/** Session 运行时门面：按 session 组装 journal 与 scheduler，不复制 turn/queue 状态。 */
import { randomUUID } from "node:crypto";
import type { ManualCompactionResult, SessionEventEnvelope } from "@answra/shared/schema";
import type {
  CancelTurnOptions,
  SessionCompactor,
  SessionId,
  SessionProjection,
  SessionRecoveryPlan,
  TurnExecutor,
  TurnId,
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
}

export class SessionRuntime {
  private readonly journal: SessionJournal;
  private readonly executor: TurnExecutor;
  private readonly compactor?: SessionCompactor;
  private readonly createTurnId: () => TurnId;
  private readonly createOperationId: () => string;
  private readonly schedulers = new Map<SessionId, Promise<TurnScheduler>>();

  constructor(options: SessionRuntimeOptions) {
    this.journal = options.journal;
    this.executor = options.executor;
    this.compactor = options.compactor;
    this.createTurnId = options.createTurnId ?? (() => turnId(randomUUID()));
    this.createOperationId = options.createOperationId ?? randomUUID;
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

  /** 启动恢复只允许在 scheduler 创建前执行；返回恢复前计划，恢复后状态用 snapshot 读取。 */
  async recover(sessionId: SessionId): Promise<SessionRecoveryPlan> {
    if (this.schedulers.has(sessionId)) {
      throw new Error(`会话已启动，不能执行启动恢复：${sessionId}`);
    }
    const plan = await recoverSession(this.journal, sessionId);
    const scheduler = await this.scheduler(sessionId);
    await scheduler.resume();
    return plan;
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
    });
    this.schedulers.set(sessionId, created);
    created.catch(() => {
      if (this.schedulers.get(sessionId) === created) this.schedulers.delete(sessionId);
    });
    return created;
  }
}

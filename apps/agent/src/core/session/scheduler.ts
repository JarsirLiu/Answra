/** 每会话串行 Turn 调度：只写 turn 生命周期事件，不执行模型、工具或压缩。 */
import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  ManualCompactionResult,
  TurnFinishReason,
  TurnOutcome,
} from "@answra/shared/schema";
import type {
  CancelTurnOptions,
  SessionCompactionRequest,
  SessionCompactor,
  SessionId,
  SessionProjection,
  TurnExecutor,
  TurnFinish,
  TurnId,
  TurnProjection,
  TurnRunContext,
  TurnStart,
  TurnSubmission,
  TurnSubmissionResult,
} from "./contracts";
import { turnId } from "./contracts";
import type { SessionJournal, SessionJournalAppend } from "./journal";
import { applySessionEvent, projectSession } from "./projection";
import { sessionErrorText } from "./sessionErrorText";

const STARTED_POSITION = 0;
const FIRST_QUEUED_POSITION = 1;

export interface TurnSchedulerOptions {
  sessionId: SessionId;
  journal: SessionJournal;
  executor: TurnExecutor;
  compactor?: SessionCompactor;
  createTurnId?: () => TurnId;
  createOperationId?: () => string;
}

export interface ManualCompactionRequest {
  operationId?: string;
  instructions?: string;
}

interface QueuedTurn {
  start: TurnStart;
  /** 从 journal 恢复的 queued Turn 没有原提交上下文；resume 必须重新注入，否则 fail-closed。 */
  runtime?: TurnRunContext;
}

interface ActiveTurn {
  start: TurnStart;
  runtime: TurnRunContext;
  controller: AbortController;
  cancelRequested: boolean;
}

interface PendingCompaction {
  request: SessionCompactionRequest;
  controller: AbortController;
  resolve: (result: ManualCompactionResult) => void;
  reject: (error: unknown) => void;
}

export class TurnScheduler {
  private readonly sessionId: SessionId;
  private readonly journal: SessionJournal;
  private readonly executor: TurnExecutor;
  private readonly compactor?: SessionCompactor;
  private readonly createTurnId: () => TurnId;
  private readonly createOperationId: () => string;
  private projection: SessionProjection;
  private readonly queued = new Map<TurnId, QueuedTurn>();
  private active?: ActiveTurn;
  private maintenance?: PendingCompaction;
  private readonly maintenanceQueue: PendingCompaction[] = [];
  private mutation = Promise.resolve();
  private readonly idleWaiters: Array<() => void> = [];

  private constructor(options: TurnSchedulerOptions, projection: SessionProjection) {
    this.sessionId = options.sessionId;
    this.journal = options.journal;
    this.executor = options.executor;
    this.compactor = options.compactor;
    this.createTurnId = options.createTurnId ?? (() => turnId(randomUUID()));
    this.createOperationId = options.createOperationId ?? randomUUID;
    this.projection = projection;
    this.hydrateQueued();
  }

  static async create(options: TurnSchedulerOptions): Promise<TurnScheduler> {
    const events = await options.journal.readAfter(options.sessionId, 0);
    const projection = projectSession(options.sessionId, events);
    return new TurnScheduler(options, projection);
  }

  async submit(submission: TurnSubmission): Promise<TurnSubmissionResult> {
    if (submission.sessionId !== this.sessionId) {
      throw new Error(`Turn 提交的 session 不匹配：${submission.sessionId}`);
    }
    const assignedTurnId = this.resolveTurnId(submission);
    return this.mutate(async () => {
      this.assertQueuedRuntime();
      if (this.projection.turns.some((turn) => turn.turnId === assignedTurnId)) {
        throw new Error(`Turn 已存在：${assignedTurnId}`);
      }
      const start = this.startFromSubmission(submission, assignedTurnId);
      const event: AgentEvent = {
        type: "turn-queued",
        source: submission.source,
        agentId: submission.agentId,
        ...(submission.input === undefined ? {} : { input: submission.input }),
      };
      await this.append(event, { turnId: assignedTurnId });
      this.queued.set(assignedTurnId, { start, runtime: submission.runtime });
      await this.scheduleNext();
      return {
        turnId: assignedTurnId,
        position: this.positionOf(assignedTurnId),
      };
    });
  }

  async cancel(target: TurnId, options: CancelTurnOptions = {}): Promise<void> {
    await this.mutate(async () => {
      if (this.queued.has(target)) {
        await this.cancelQueuedTurns(options.cancelQueued === true ? undefined : target);
        await this.scheduleNext();
        return;
      }
      if (this.active?.start.turnId === target) {
        this.active.cancelRequested = true;
        if (options.cancelQueued === true) await this.cancelQueuedTurns();
        this.active.controller.abort();
        return;
      }
      if (this.projection.activeTurnId === target) {
        throw new Error(`Turn 正在恢复，当前 Scheduler 无法取消：${target}`);
      }
      throw new Error(`Turn 不存在或已结束：${target}`);
    });
  }

  async requestCompaction(request: ManualCompactionRequest = {}): Promise<ManualCompactionResult> {
    if (this.compactor === undefined) throw new Error("未配置压缩执行器");
    let resolve!: (result: ManualCompactionResult) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<ManualCompactionResult>((resolveResult, rejectResult) => {
      resolve = resolveResult;
      reject = rejectResult;
    });
    const job = this.createCompactionJob(request, resolve, reject);
    await this.mutate(async () => {
      this.maintenanceQueue.push(job);
      await this.scheduleNext();
    });
    return result;
  }

  async resume(runtime: TurnRunContext): Promise<void> {
    await this.mutate(async () => {
      await this.refresh();
      this.hydrateQueued(runtime);
      await this.scheduleNext();
    });
  }

  snapshot(): SessionProjection {
    return this.projection;
  }

  waitForIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private resolveTurnId(submission: TurnSubmission): TurnId {
    if (submission.source !== "user") return this.createTurnId();
    if (submission.input === undefined) throw new Error("用户 Turn 缺少输入消息");
    return turnId(submission.input.id);
  }

  private startFromSubmission(submission: TurnSubmission, assignedTurnId: TurnId): TurnStart {
    return {
      sessionId: this.sessionId,
      turnId: assignedTurnId,
      source: submission.source,
      agentId: submission.agentId,
      ...(submission.input === undefined ? {} : { input: submission.input }),
    };
  }

  private startFromProjection(turn: TurnProjection): TurnStart {
    return {
      sessionId: this.sessionId,
      turnId: turn.turnId,
      source: turn.source,
      agentId: turn.agentId,
      ...(turn.input === undefined ? {} : { input: turn.input }),
    };
  }

  private hydrateQueued(runtime?: TurnRunContext): void {
    for (const turn of this.projection.turns) {
      if (turn.status !== "queued") continue;
      const existing = this.queued.get(turn.turnId);
      if (existing !== undefined) {
        if (existing.runtime === undefined && runtime !== undefined) {
          this.queued.set(turn.turnId, { ...existing, runtime });
        }
        continue;
      }
      this.queued.set(turn.turnId, {
        start: this.startFromProjection(turn),
        ...(runtime === undefined ? {} : { runtime }),
      });
    }
  }

  private assertQueuedRuntime(): void {
    for (const [turnId, queued] of this.queued) {
      if (queued.runtime === undefined) {
        throw new Error(`queued Turn 缺少运行时上下文，请先 recover：${turnId}`);
      }
    }
  }

  private async scheduleNext(): Promise<void> {
    if (this.isBusy()) return;
    const compaction = this.maintenanceQueue.shift();
    if (compaction !== undefined) {
      this.maintenance = compaction;
      void this.executeCompaction(compaction);
      return;
    }
    const nextTurnId = this.projection.queue[0];
    if (nextTurnId === undefined) {
      this.notifyIdle();
      return;
    }
    const queued = this.queued.get(nextTurnId);
    if (queued === undefined) throw new Error(`缺少 queued Turn 输入：${nextTurnId}`);
    if (queued.runtime === undefined) {
      throw new Error(`queued Turn 缺少运行时上下文，请先 recover：${nextTurnId}`);
    }
    await this.startTurn(queued.start, queued.runtime);
  }

  private async startTurn(start: TurnStart, runtime: TurnRunContext): Promise<void> {
    const controller = new AbortController();
    await this.append({ type: "turn-started", agentId: start.agentId }, { turnId: start.turnId });
    this.queued.delete(start.turnId);
    const active: ActiveTurn = { start, runtime, controller, cancelRequested: false };
    this.active = active;
    void this.executeTurn(active);
  }

  private async executeTurn(active: ActiveTurn): Promise<void> {
    let finish: TurnFinish;
    try {
      finish = await this.executor.run(active.start, active.runtime, active.controller.signal);
      if (finish.turnId !== active.start.turnId) {
        throw new Error(`TurnExecutor 返回了不同的 turnId：${finish.turnId}`);
      }
    } catch (error) {
      finish = {
        turnId: active.start.turnId,
        outcome: active.cancelRequested ? "aborted" : "failed",
        reason: active.cancelRequested ? "cancelled" : "unknown",
        ...(active.cancelRequested ? {} : { errorText: sessionErrorText(error) }),
      };
    }
    if (active.cancelRequested) {
      finish = { turnId: active.start.turnId, outcome: "aborted", reason: "cancelled" };
    }

    await this.mutate(async () => {
      if (this.active !== active) return;
      await this.append(
        {
          type: "turn-finished",
          status: finish.outcome,
          reason: finish.reason ?? defaultFinishReason(finish.outcome),
          ...(finish.errorText === undefined ? {} : { errorText: finish.errorText }),
        },
        { turnId: finish.turnId },
      );
      this.active = undefined;
      await this.scheduleNext();
    });
  }

  private createCompactionJob(
    request: ManualCompactionRequest,
    resolve: (result: ManualCompactionResult) => void,
    reject: (error: unknown) => void,
  ): PendingCompaction {
    const operationId = request.operationId ?? this.createOperationId();
    return {
      request: {
        sessionId: this.sessionId,
        operationId,
        ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
      },
      controller: new AbortController(),
      resolve,
      reject,
    };
  }

  private async executeCompaction(job: PendingCompaction): Promise<void> {
    try {
      const compactor = this.compactor;
      if (compactor === undefined) throw new Error("未配置压缩执行器");
      job.resolve(await compactor.compact(job.request, job.controller.signal));
    } catch (error) {
      job.reject(error);
    } finally {
      await this.mutate(async () => {
        if (this.maintenance === job) this.maintenance = undefined;
        await this.refresh();
        await this.scheduleNext();
      });
    }
  }

  private async cancelQueuedTurns(only?: TurnId): Promise<void> {
    const targets = only === undefined ? [...this.queued.keys()] : [only];
    for (const target of targets) {
      const queued = this.queued.get(target);
      if (queued === undefined) continue;
      await this.append(
        { type: "turn-finished", status: "aborted", reason: "cancelled" },
        { turnId: queued.start.turnId },
      );
      this.queued.delete(queued.start.turnId);
    }
  }

  private positionOf(target: TurnId): number {
    if (this.active?.start.turnId === target) return STARTED_POSITION;
    const index = this.projection.queue.indexOf(target);
    if (index < 0) throw new Error(`Turn 不在队列中：${target}`);
    return index + FIRST_QUEUED_POSITION;
  }

  private isBusy(): boolean {
    return (
      this.active !== undefined ||
      this.maintenance !== undefined ||
      this.projection.activeTurnId !== undefined
    );
  }

  private isIdle(): boolean {
    return (
      !this.isBusy() && this.projection.queue.length === 0 && this.maintenanceQueue.length === 0
    );
  }

  private notifyIdle(): void {
    if (!this.isIdle()) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private async append(event: AgentEvent, metadata: SessionJournalAppend): Promise<void> {
    await this.journal.append(this.sessionId, event, metadata);
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    const events = await this.journal.readAfter(this.sessionId, this.projection.sequence);
    for (const event of events) this.projection = applySessionEvent(this.projection, event);
  }

  private async mutate<T>(action: () => Promise<T>): Promise<T> {
    const run = this.mutation.then(action, action);
    this.mutation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function defaultFinishReason(outcome: TurnOutcome): TurnFinishReason {
  if (outcome === "completed") return "completed";
  if (outcome === "aborted") return "cancelled";
  return "unknown";
}

/** 跨领域单会话 turn 串行队列：按提交顺序启动完整 turn，不实现模型、transcript 或产品语义。 */
import type { ConversationSnapshot } from "@answra/shared";

export type TurnQueueOutcome = "completed" | "failed" | "aborted";

export interface TurnQueueStartResult {
  runId: string;
  snapshot: ConversationSnapshot;
  completion: Promise<TurnQueueOutcome>;
}

export type TurnQueueEnqueueResult =
  | {
      queueId: string;
      status: "started";
      position: 0;
      runId: string;
      snapshot: ConversationSnapshot;
    }
  | { queueId: string; status: "queued"; position: number };

export interface TurnQueueCompletion {
  queueId: string;
  runId?: string;
  outcome: TurnQueueOutcome;
  failure?: { error: unknown };
}

export interface TurnQueueStart {
  queueId: string;
  runId: string;
  snapshot: ConversationSnapshot;
}

/** 已完成的等待结果有界缓存；客户端可能在 run 结束后才补发 wait。 */
const COMPLETED_TURN_LIMIT = 256;

interface QueueItem {
  queueId: string;
  start: () => Promise<TurnQueueStartResult>;
  runId?: string;
  resolve: (completion: TurnQueueCompletion) => void;
  completion: Promise<TurnQueueCompletion>;
  resolveStart: (start: TurnQueueStart) => void;
  rejectStart: (error: unknown) => void;
  started: Promise<TurnQueueStart>;
}

export class TurnQueue {
  private readonly pending: QueueItem[] = [];
  private readonly completed = new Map<string, Promise<TurnQueueCompletion>>();
  private readonly positions = new Map<string, number>();
  private active?: QueueItem;
  private disposed = false;
  private sequence = 0;

  enqueue(start: () => Promise<TurnQueueStartResult>): Promise<TurnQueueEnqueueResult> {
    if (this.disposed) throw new Error("会话队列已关闭");
    let resolveCompletion!: (completion: TurnQueueCompletion) => void;
    let resolveStart!: (start: TurnQueueStart) => void;
    let rejectStart!: (error: unknown) => void;
    const completion = new Promise<TurnQueueCompletion>((resolve) => {
      resolveCompletion = resolve;
    });
    const started = new Promise<TurnQueueStart>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    const item: QueueItem = {
      queueId: `turn-queue-${++this.sequence}`,
      start,
      resolve: resolveCompletion,
      completion,
      resolveStart,
      rejectStart,
      started,
    };
    void started.catch(() => undefined);
    if (this.active !== undefined) {
      this.pending.push(item);
      this.positions.set(item.queueId, this.pending.length);
      return Promise.resolve({
        queueId: item.queueId,
        status: "queued",
        position: this.pending.length,
      });
    }
    this.active = item;
    return this.startActive(item);
  }

  waitForStart(queueId: string): Promise<TurnQueueStart> {
    if (this.active?.queueId === queueId) return this.active.started;
    const pending = this.pending.find((item) => item.queueId === queueId);
    if (pending) return pending.started;
    return Promise.reject(new Error("队列消息不存在"));
  }

  wait(queueId: string): Promise<TurnQueueCompletion> {
    if (this.active?.queueId === queueId) return this.active.completion;
    const pending = this.pending.find((item) => item.queueId === queueId);
    if (pending) return pending.completion;
    const completed = this.completed.get(queueId);
    if (completed) return completed;
    return Promise.reject(new Error("队列消息不存在"));
  }

  /** 取消所有尚未启动的 turn；活动 turn 由调用方单独取消。 */
  cancelPending(): void {
    const removed = this.pending.splice(0);
    for (const item of removed) {
      this.positions.delete(item.queueId);
      this.rememberCompletion(item);
      item.resolve({ queueId: item.queueId, outcome: "aborted" });
      item.rejectStart(new Error("队列消息已取消"));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPending();
    this.positions.clear();
    this.completed.clear();
  }

  get activeQueueId(): string | undefined {
    return this.active?.queueId;
  }

  get activeRunId(): string | undefined {
    return this.active?.runId;
  }

  get queuedCount(): number {
    return this.pending.length;
  }

  position(queueId: string): number | undefined {
    return this.positions.get(queueId);
  }

  private async startActive(item: QueueItem): Promise<TurnQueueEnqueueResult> {
    try {
      const started = await item.start();
      item.runId = started.runId;
      item.resolveStart({
        queueId: item.queueId,
        runId: started.runId,
        snapshot: started.snapshot,
      });
      void started.completion.then(
        (outcome) => this.finishActive(item, outcome),
        (error: unknown) => this.finishActive(item, "failed", { failure: { error } }),
      );
      return {
        queueId: item.queueId,
        status: "started",
        position: 0,
        runId: started.runId,
        snapshot: started.snapshot,
      };
    } catch (error) {
      this.active = undefined;
      this.rememberCompletion(item);
      item.resolve({ queueId: item.queueId, outcome: "failed" });
      item.rejectStart(error);
      void this.startNext();
      throw error;
    }
  }

  private async finishActive(
    item: QueueItem,
    outcome: TurnQueueOutcome,
    failure?: { failure: { error: unknown } },
  ): Promise<void> {
    item.resolve({ queueId: item.queueId, runId: item.runId, outcome, ...failure });
    this.rememberCompletion(item);
    if (this.active?.queueId !== item.queueId) return;
    this.active = undefined;
    await this.startNext();
  }

  private async startNext(): Promise<void> {
    if (this.disposed || this.active !== undefined) return;
    const next = this.pending.shift();
    if (!next) return;
    this.positions.delete(next.queueId);
    for (const [index, item] of this.pending.entries()) {
      this.positions.set(item.queueId, index + 1);
    }
    this.active = next;
    try {
      const started = await next.start();
      next.runId = started.runId;
      next.resolveStart({
        queueId: next.queueId,
        runId: started.runId,
        snapshot: started.snapshot,
      });
      void started.completion.then(
        (outcome) => this.finishActive(next, outcome),
        (error: unknown) => this.finishActive(next, "failed", { failure: { error } }),
      );
    } catch (error) {
      next.rejectStart(error);
      await this.finishActive(next, "failed", { failure: { error } });
    }
  }

  private rememberCompletion(item: QueueItem): void {
    this.completed.set(item.queueId, item.completion);
    while (this.completed.size > COMPLETED_TURN_LIMIT) {
      const oldest = this.completed.keys().next().value;
      if (oldest === undefined) return;
      this.completed.delete(oldest);
    }
  }
}

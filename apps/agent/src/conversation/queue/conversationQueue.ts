/** Conversation 用户消息队列：按会话串行启动完整用户回合，不实现模型或 transcript 语义。 */
import type { ConversationSnapshot } from "@answra/shared";

export type ConversationQueueOutcome = "completed" | "failed" | "aborted";

export interface ConversationQueueStartResult {
  runId: string;
  snapshot: ConversationSnapshot;
  completion: Promise<ConversationQueueOutcome>;
}

export type ConversationQueueEnqueueResult =
  | {
      queueId: string;
      status: "started";
      position: 0;
      runId: string;
      snapshot: ConversationSnapshot;
    }
  | { queueId: string; status: "queued"; position: number };

export interface ConversationQueueCompletion {
  queueId: string;
  runId?: string;
  outcome: ConversationQueueOutcome;
  failure?: { error: unknown };
}

export interface ConversationQueueStart {
  queueId: string;
  runId: string;
  snapshot: ConversationSnapshot;
}

interface QueueItem {
  queueId: string;
  start: () => Promise<ConversationQueueStartResult>;
  runId?: string;
  resolve: (completion: ConversationQueueCompletion) => void;
  completion: Promise<ConversationQueueCompletion>;
  resolveStart: (start: ConversationQueueStart) => void;
  rejectStart: (error: unknown) => void;
  started: Promise<ConversationQueueStart>;
}

export class ConversationQueue {
  private readonly pending: QueueItem[] = [];
  private readonly completed = new Map<string, Promise<ConversationQueueCompletion>>();
  private active?: QueueItem;
  private disposed = false;
  private sequence = 0;
  private readonly positions = new Map<string, number>();

  enqueue(
    start: () => Promise<ConversationQueueStartResult>,
  ): Promise<ConversationQueueEnqueueResult> {
    if (this.disposed) throw new Error("会话队列已关闭");
    let resolveCompletion!: (completion: ConversationQueueCompletion) => void;
    let resolveStart!: (start: ConversationQueueStart) => void;
    let rejectStart!: (error: unknown) => void;
    const completion = new Promise<ConversationQueueCompletion>((resolve) => {
      resolveCompletion = resolve;
    });
    const started = new Promise<ConversationQueueStart>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    const item: QueueItem = {
      queueId: `conversation-queue-${++this.sequence}`,
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

  waitForStart(queueId: string): Promise<ConversationQueueStart> {
    if (this.active?.queueId === queueId) return this.active.started;
    const pending = this.pending.find((item) => item.queueId === queueId);
    if (pending) return pending.started;
    return Promise.reject(new Error("队列消息不存在"));
  }

  wait(queueId: string): Promise<ConversationQueueCompletion> {
    if (this.active?.queueId === queueId) return this.active.completion;
    const pending = this.pending.find((item) => item.queueId === queueId);
    if (pending) return pending.completion;
    const completed = this.completed.get(queueId);
    if (completed) return completed;
    return Promise.reject(new Error("队列消息不存在"));
  }

  cancelPending(): void {
    const removed = this.pending.splice(0);
    for (const item of removed) {
      item.resolve({ queueId: item.queueId, outcome: "aborted" });
      item.rejectStart(new Error("队列消息已取消"));
      this.completed.set(item.queueId, item.completion);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPending();
  }

  get activeQueueId(): string | undefined {
    return this.active?.queueId;
  }

  get queuedCount(): number {
    return this.pending.length;
  }

  private async startActive(item: QueueItem): Promise<ConversationQueueEnqueueResult> {
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
      item.resolve({ queueId: item.queueId, outcome: "failed" });
      item.rejectStart(error);
      void this.startNext();
      throw error;
    }
  }

  private async finishActive(
    item: QueueItem,
    outcome: ConversationQueueOutcome,
    failure?: { failure: { error: unknown } },
  ): Promise<void> {
    item.resolve({ queueId: item.queueId, runId: item.runId, outcome, ...failure });
    this.completed.set(item.queueId, item.completion);
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

  position(queueId: string): number | undefined {
    return this.positions.get(queueId);
  }
}

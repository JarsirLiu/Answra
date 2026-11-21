/** 跨领域会话队列注册表：按 conversationId 持有 turn 队列并关联已启动 run；不实现模型或 transcript。 */
import {
  TurnQueue,
  type TurnQueueCompletion,
  type TurnQueueEnqueueResult,
  type TurnQueueStart,
  type TurnQueueStartResult,
} from "./turnQueue";

export class TurnQueueRegistry {
  private readonly queues = new Map<string, TurnQueue>();
  private readonly runConversations = new Map<string, string>();
  private readonly lastRunByConversation = new Map<string, string>();

  enqueue(
    conversationId: string,
    start: () => Promise<TurnQueueStartResult>,
  ): Promise<TurnQueueEnqueueResult> {
    return this.queueFor(conversationId).enqueue(start);
  }

  waitForStart(conversationId: string, queueId: string): Promise<TurnQueueStart> {
    return this.requireQueue(conversationId).waitForStart(queueId);
  }

  wait(conversationId: string, queueId: string): Promise<TurnQueueCompletion> {
    return this.requireQueue(conversationId).wait(queueId);
  }

  position(conversationId: string, queueId: string): number | undefined {
    return this.queues.get(conversationId)?.position(queueId);
  }

  queuedCount(conversationId: string): number {
    return this.queues.get(conversationId)?.queuedCount ?? 0;
  }

  hasQueued(conversationId: string): boolean {
    const queue = this.queues.get(conversationId);
    return queue?.activeQueueId !== undefined || (queue?.queuedCount ?? 0) > 0;
  }

  activeQueueId(conversationId: string): string | undefined {
    return this.queues.get(conversationId)?.activeQueueId;
  }

  activeRunId(conversationId: string): string | undefined {
    return this.queues.get(conversationId)?.activeRunId;
  }

  cancelPending(conversationId: string): void {
    this.queues.get(conversationId)?.cancelPending();
  }

  trackRun(conversationId: string, runId: string): void {
    this.runConversations.set(runId, conversationId);
    this.lastRunByConversation.set(conversationId, runId);
  }

  untrackRun(runId: string): void {
    this.runConversations.delete(runId);
  }

  /**
   * 取消请求只带 runId；活动 run 结束后、下一条 turn 启动前，优先按最近一次 run 仍能找到会话。
   * 仅在取消路径使用，不对热路径做全表关联。
   */
  conversationForRun(runId: string): string | undefined {
    const active = this.runConversations.get(runId);
    if (active !== undefined) return active;
    for (const [conversationId, lastRunId] of this.lastRunByConversation) {
      if (lastRunId === runId) return conversationId;
    }
    return undefined;
  }

  dispose(): void {
    for (const queue of this.queues.values()) queue.dispose();
    this.queues.clear();
    this.runConversations.clear();
    this.lastRunByConversation.clear();
  }

  private queueFor(conversationId: string): TurnQueue {
    const existing = this.queues.get(conversationId);
    if (existing) return existing;
    const queue = new TurnQueue();
    this.queues.set(conversationId, queue);
    return queue;
  }

  private requireQueue(conversationId: string): TurnQueue {
    const queue = this.queues.get(conversationId);
    if (!queue) throw new Error("会话队列不存在");
    return queue;
  }
}

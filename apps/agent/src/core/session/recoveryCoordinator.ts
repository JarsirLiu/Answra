/**
 * 启动恢复的唯一顺序：先收口未完成事实，再用条目重建消息视图，最后续跑 queued Turn。
 *
 * 恢复是跨领域需求（Conversation / Interview / Coding），顺序一旦分叉就会出现
 * 不同的判据；因此这里只编排注入端口，不持有领域状态。
 * `ensure` 必须在 Scheduler 创建前执行，且同一 session 的并发 ensure 只跑一次。
 */
import type { SessionId, SessionRecoveryPlan, TurnRunContext } from "./contracts";

export interface SessionRecoveryPorts {
  /** 补写缺失的收口条目；不启动 queued Turn。 */
  recoverFacts(sessionId: SessionId): Promise<SessionRecoveryPlan>;
  /** 用条目重建内存消息视图；保留仍在流式的活动消息。 */
  refreshTranscript(sessionId: SessionId): Promise<void>;
  /** 消息视图重建完成后继续消费 queued Turn。 */
  resumeQueued(sessionId: SessionId, runtime: TurnRunContext): Promise<void>;
  /** 恢复完成后通知宿主；是否推送 snapshot 由宿主决定。 */
  onRecovered?(sessionId: SessionId, plan: SessionRecoveryPlan): void | Promise<void>;
}

export class SessionRecoveryCoordinator {
  private readonly recovered = new Set<SessionId>();
  private readonly inFlight = new Map<SessionId, Promise<void>>();

  constructor(private readonly ports: SessionRecoveryPorts) {}

  isRecovered(sessionId: SessionId): boolean {
    return this.recovered.has(sessionId);
  }

  /** 会话被清空后必须丢弃恢复标记，否则下一次发送会跳过新会话的恢复。 */
  forget(sessionId: SessionId): void {
    this.recovered.delete(sessionId);
    this.inFlight.delete(sessionId);
  }

  /** 幂等且并发安全：同一 session 的并发调用共享同一次恢复。 */
  ensure(sessionId: SessionId, runtime: TurnRunContext): Promise<void> {
    if (this.recovered.has(sessionId)) return Promise.resolve();
    const pending = this.inFlight.get(sessionId);
    if (pending !== undefined) return pending;
    const started = this.run(sessionId, runtime).finally(() => {
      if (this.inFlight.get(sessionId) === started) this.inFlight.delete(sessionId);
    });
    this.inFlight.set(sessionId, started);
    return started;
  }

  private async run(sessionId: SessionId, runtime: TurnRunContext): Promise<void> {
    const plan = await this.ports.recoverFacts(sessionId);
    await this.ports.refreshTranscript(sessionId);
    // 必须晚于视图重建：queued Turn 一启动就会读 transcript 建 user/assistant 消息。
    await this.ports.resumeQueued(sessionId, runtime);
    this.recovered.add(sessionId);
    await this.ports.onRecovered?.(sessionId, plan);
  }
}

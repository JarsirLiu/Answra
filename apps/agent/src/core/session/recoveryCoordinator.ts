/**
 * 启动恢复的唯一顺序：先对齐 UI revision，再收口未完成事实，然后 seed durable 游标，
 * 最后写回 transcript。
 *
 * 恢复是跨领域需求（Conversation / Interview / Coding），顺序一旦分叉就会出现
 * 不同的 revision 语义；因此这里只编排注入端口，不持有领域状态。
 * `recover` 必须在 Scheduler 创建前执行，且同一 session 的并发 ensure 只跑一次。
 */
import type { SessionId, SessionRecoveryPlan, TurnRunContext } from "./contracts";

export interface SessionRecoveryPorts {
  /** 写回未完成 Turn/Step/Compaction 事实；不启动 queued Turn。 */
  recoverFacts(sessionId: SessionId): Promise<SessionRecoveryPlan>;
  /** transcript 写回完成后继续消费 queued Turn。 */
  resumeQueued(sessionId: SessionId, runtime: TurnRunContext): Promise<void>;
  /** transcript 的持久事件游标；用于把 UI revision 对齐到已展示历史。 */
  eventRevision(sessionId: SessionId): Promise<number>;
  seedRevision(sessionId: SessionId, revision: number): Promise<void>;
  revision(sessionId: SessionId): Promise<number>;
  /** journal 已落库的最大 durable seq；恢复后用它 seed 快照游标。 */
  journalLastSeq(sessionId: SessionId): Promise<number>;
  /** 把 transcript 快照游标推进到该 seq；晚于它的事实由客户端按帧重放。 */
  seedLastSeq(sessionId: SessionId, sequence: number): Promise<void>;
  /** 恢复写回属于旧进程事实，期间必须暂停该 session 的 UI 投影。 */
  suspendUi(sessionId: SessionId, suspended: boolean): void;
  restoreTranscript(
    sessionId: SessionId,
    plan: SessionRecoveryPlan,
    eventRevision: number,
  ): Promise<void>;
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
    await this.ports.seedRevision(sessionId, await this.ports.eventRevision(sessionId));
    this.ports.suspendUi(sessionId, true);
    let plan: SessionRecoveryPlan;
    try {
      plan = await this.ports.recoverFacts(sessionId);
    } finally {
      this.ports.suspendUi(sessionId, false);
    }
    // 恢复事实已经写回 transcript；把游标 seed 到 journal 末尾，重启后不重放整本 journal。
    await this.ports.seedLastSeq(sessionId, await this.ports.journalLastSeq(sessionId));
    await this.ports.restoreTranscript(sessionId, plan, await this.ports.revision(sessionId));
    // 必须晚于 transcript 写回：queued Turn 一启动就会读 transcript 建 user/assistant 消息。
    await this.ports.resumeQueued(sessionId, runtime);
    this.recovered.add(sessionId);
    await this.ports.onRecovered?.(sessionId, plan);
  }
}

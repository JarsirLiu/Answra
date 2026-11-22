/**
 * Session 事件到 renderer AgentEventEnvelope 的兼容投影。
 *
 * renderer 仍只认 AgentEventEnvelope，并按 aggregateRevision 单调消费事件；
 * 因此 live 增量与 durable 事件必须共用 ExecutionStore 的同一 revision 计数器。
 * 这里不推导 Turn/Step 状态，只做协议映射，事件语义仍由 Session 底座持有。
 */
import {
  type AgentDurableEvent,
  type AgentEvent,
  type AgentEventEnvelope,
  type AgentStreamEvent,
  agentDurableEventSchema,
  type SessionEventEnvelope,
} from "@answra/shared/schema";
import type { ExecutionStore } from "../../execution/store";
import { type StepStart, type TurnId, turnId } from "./contracts";

const PRODUCER_ID = "answra-agent";

export interface SessionEventProjectorOptions {
  store: ExecutionStore;
}

export class SessionEventProjector {
  private readonly store: ExecutionStore;
  private readonly startedRuns = new Set<string>();
  private readonly currentRun = new Map<string, string>();
  private readonly runOwner = new Map<string, { sessionId: string; turnId?: TurnId }>();
  private readonly suspendedSessions = new Set<string>();

  constructor({ store }: SessionEventProjectorOptions) {
    this.store = store;
  }

  /** 首事件前用 transcript 的持久 revision 对齐游标，避免重连后被 UI 丢弃。 */
  seed(sessionId: string, revision: number): Promise<void> {
    return this.store.seedConversationRevision(sessionId, revision);
  }

  revision(sessionId: string): Promise<number> {
    return this.store.getConversationRevision(sessionId);
  }

  readEvents(sessionId: string, afterRevision: number): Promise<AgentEventEnvelope[]> {
    return this.store.readEvents(sessionId, afterRevision);
  }

  conversationForRun(runId: string): string | undefined {
    return this.runOwner.get(runId)?.sessionId;
  }

  turnForRun(runId: string): TurnId | undefined {
    return this.runOwner.get(runId)?.turnId;
  }

  /**
   * 启动恢复写入的终态属于旧进程，不进入新进程的 UI 事件流。
   * 按 session 挂起：两个会话并发恢复时不能互相放行。
   */
  suspend(sessionId: string, suspended: boolean): void {
    if (suspended) this.suspendedSessions.add(sessionId);
    else this.suspendedSessions.delete(sessionId);
  }

  /** journal 的 durable 事件：只做协议映射，一条 session 事件最多产生一条 UI 生命周期事件。 */
  async apply(envelope: SessionEventEnvelope): Promise<void> {
    if (this.suspendedSessions.has(envelope.sessionId)) return;
    const sessionId = envelope.sessionId;
    const event = envelope.event;
    if (event.type === "turn-queued") return;
    // 压缩是会话级事实，没有 run 归属；进度通过边界 snapshot 展示，不能混进 assistant 事件流。
    if (isCompactionEvent(event.type)) return;

    if (event.type === "turn-started") {
      const runId = requireRunId(envelope);
      await this.startRun(
        sessionId,
        runId,
        envelope.turnId === undefined ? undefined : turnId(envelope.turnId),
      );
      this.currentRun.set(sessionId, runId);
      await this.append(runId, event, envelope.stepId);
      return;
    }

    if (event.type === "step-started") {
      const runId = envelope.messageId ?? this.currentRun.get(sessionId);
      if (runId === undefined) throw new Error("step-started 缺少 assistant 消息 id");
      if (!this.startedRuns.has(runId))
        await this.startRun(
          sessionId,
          runId,
          envelope.turnId === undefined ? undefined : turnId(envelope.turnId),
        );
      this.currentRun.set(sessionId, runId);
      await this.append(runId, event, envelope.stepId);
      return;
    }

    const runId = envelope.messageId ?? this.currentRun.get(sessionId);
    if (event.type === "turn-handoff") {
      if (runId === undefined) return;
      await this.store.finishRun(runId, "completed");
      this.releaseRun(runId);
      await this.append(runId, event, envelope.stepId);
      return;
    }

    if (event.type === "turn-finished") {
      // Turn 事件必须按 turnId 归属收口：queued Turn 被取消时没有启动过 run，
      // 不能借用 `currentRun`，否则会错误终止另一个正在运行的 Turn。
      const owned =
        envelope.turnId === undefined
          ? runId === undefined
            ? []
            : [runId]
          : this.runsForTurn(sessionId, envelope.turnId);
      for (const id of owned) {
        await this.store.finishRun(id, terminalOutcome(event.status));
        this.releaseRun(id);
      }
      this.currentRun.delete(sessionId);
      const target = owned.at(-1);
      if (target !== undefined) await this.append(target, event, envelope.stepId);
      return;
    }

    if (runId === undefined) return;
    await this.append(runId, event, envelope.stepId);
  }

  /** live-only 增量：不落 journal，但必须进入同一 revision 序列供 UI 实时渲染。 */
  async applyLive(step: StepStart, event: AgentStreamEvent): Promise<void> {
    // durable 事件已由 journal 路径投影，这里只处理不落库的高频增量。
    if (agentDurableEventSchema.safeParse(event).success) return;
    const runId = step.messageId;
    if (!this.startedRuns.has(runId)) return;
    await this.append(runId, event, step.stepId);
  }

  private async startRun(sessionId: string, runId: string, turnId?: TurnId): Promise<void> {
    if (this.startedRuns.has(runId)) return;
    await this.store.startRun({
      runId,
      conversationId: sessionId,
      producerId: PRODUCER_ID,
    });
    await this.store.transition(runId, "running");
    this.startedRuns.add(runId);
    this.runOwner.set(runId, { sessionId, ...(turnId === undefined ? {} : { turnId }) });
  }

  private runsForTurn(sessionId: string, turnId: string): string[] {
    const runs: string[] = [];
    for (const [runId, owner] of this.runOwner) {
      if (owner.sessionId === sessionId && owner.turnId === turnId) runs.push(runId);
    }
    return runs;
  }

  /** Terminal 后释放 run 归属，避免长会话内 Map 无界增长。 */
  private releaseRun(runId: string): void {
    this.runOwner.delete(runId);
    this.startedRuns.delete(runId);
  }

  private append(runId: string, event: AgentEvent, stepId: string | undefined): Promise<unknown> {
    return this.store.appendEvent(runId, event, stepId === undefined ? {} : { stepId });
  }
}

function requireRunId(envelope: SessionEventEnvelope): string {
  if (envelope.messageId === undefined) {
    throw new Error(`${envelope.event.type} 缺少 messageId，无法映射为 UI runId`);
  }
  return envelope.messageId;
}

function terminalOutcome(status: "completed" | "failed" | "aborted") {
  return status;
}

function isCompactionEvent(type: AgentDurableEvent["type"]): boolean {
  return type.startsWith("compaction-");
}

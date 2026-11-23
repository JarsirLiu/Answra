/** Session 事件到 transcript 消息的桥接：只投影展示事实，不复制 Turn 状态机。 */
import { randomUUID } from "node:crypto";
import type { ConversationMessage } from "@answra/shared";
import {
  type AgentDurableEvent,
  type AgentStreamEvent,
  agentStreamEventSchema,
  type SessionEventEnvelope,
} from "@answra/shared/schema";
import type { ConversationStore } from "../transcript/store";
import type { SessionId, SessionRecoveryPlan } from "./contracts";
import type { SessionJournal, SessionJournalAppend } from "./journal";

interface TurnTranscriptState {
  input?: ConversationMessage;
  /** 当前正在流式写入的 assistant 消息；交接后清空。 */
  messageId?: string;
  /** 下一个 step 属于该交接目标 Bot，需要先追加 assistant 占位。 */
  handoffTarget?: string;
}

/**
 * 按 journal 事件维护 transcript 展示消息。
 * 增量由宿主经 `applyLive` 直接写入；journal 只负责 durable 事件，避免重复投影。
 */
export class SessionTranscriptBridge {
  private readonly store: ConversationStore;
  private readonly turns = new Map<string, TurnTranscriptState>();

  constructor({ store }: { store: ConversationStore }) {
    this.store = store;
  }

  async apply(envelope: SessionEventEnvelope): Promise<void> {
    await this.project(envelope);
    // 只有投影成功才推进游标：失败时客户端必须能从旧游标重读这条事实。
    await this.store.advanceLastSeq(envelope.sessionId, envelope.sequence);
  }

  private async project(envelope: SessionEventEnvelope): Promise<void> {
    switch (envelope.event.type) {
      case "turn-queued":
        this.state(envelope).input = envelope.event.input;
        return;
      case "turn-started":
        await this.beginTurn(envelope);
        return;
      case "step-started":
        await this.beginStep(envelope);
        return;
      case "turn-handoff":
        await this.applyHandoff(envelope);
        return;
      case "turn-finished":
        await this.finishTurn(envelope);
        return;
      default:
        await this.applyDurableStream(envelope);
    }
  }

  /** live-only 增量只走实时通道；durable 事件由 journal 路径投影。 */
  async applyLive(sessionId: SessionId, messageId: string, event: AgentStreamEvent): Promise<void> {
    if (!isLiveOnly(event)) return;
    await this.store.applySessionStreamEvent(sessionId, messageId, event);
  }

  /** 启动恢复后收口中断 Turn 的最后一条 assistant 消息；已完成的交接消息不重写。 */
  async recover(sessionId: SessionId, plan: SessionRecoveryPlan): Promise<void> {
    // `turn-queued` 的输入只存在于旧进程内存或 journal；重启后的 bridge 没有该状态。
    // 用恢复计划补齐 queued Turn 的输入，否则恢复执行时用户消息会从 transcript 消失。
    for (const turn of plan.projection.turns) {
      if (turn.status !== "queued" || turn.input === undefined) continue;
      const state = this.turnState(turn.turnId);
      if (state.input === undefined) state.input = turn.input;
    }
    for (const interrupted of plan.interruptedTurnIds) {
      const turn = plan.projection.turns.find((candidate) => candidate.turnId === interrupted);
      const messageId = turn?.assistantMessageIds.at(-1);
      if (messageId !== undefined) {
        await this.store.finishSessionAssistant(sessionId, messageId, "aborted");
      }
    }
  }

  private async beginTurn(envelope: SessionEventEnvelope): Promise<void> {
    if (envelope.turnId === undefined) throw new Error("turn-started 缺少 turnId");
    if (envelope.messageId === undefined) throw new Error("turn-started 缺少 messageId");
    const event = envelope.event;
    if (event.type !== "turn-started") return;
    const state = this.state(envelope);
    state.messageId = envelope.messageId;
    await this.store.beginSessionTurn(envelope.sessionId, {
      turnId: envelope.turnId,
      messageId: envelope.messageId,
      authorAgentId: event.agentId,
      ...(state.input === undefined ? {} : { userMessage: state.input }),
    });
  }

  private async beginStep(envelope: SessionEventEnvelope): Promise<void> {
    if (envelope.messageId === undefined) throw new Error("step-started 缺少 messageId");
    const state = this.state(envelope);
    if (state.messageId === envelope.messageId) return;
    if (state.messageId !== undefined) {
      throw new Error(
        `step-started 的 assistant 消息不连续：${state.messageId} -> ${envelope.messageId}`,
      );
    }
    if (state.handoffTarget === undefined) {
      throw new Error(`step-started 缺少 assistant 占位：${envelope.messageId}`);
    }
    await this.store.beginSessionAssistant(
      envelope.sessionId,
      envelope.messageId,
      state.handoffTarget,
    );
    state.messageId = envelope.messageId;
    state.handoffTarget = undefined;
  }

  private async applyHandoff(envelope: SessionEventEnvelope): Promise<void> {
    if (envelope.messageId === undefined) throw new Error("turn-handoff 缺少来源 messageId");
    const event = envelope.event;
    if (event.type !== "turn-handoff") return;
    await this.store.finishSessionAssistant(
      envelope.sessionId,
      envelope.messageId,
      "completed",
    );
    await this.store.appendHandoffMessage(envelope.sessionId, {
      id: randomUUID(),
      fromAgentId: event.fromAgentId,
      toAgentId: event.toAgentId,
      task: event.task,
    });
    const state = this.state(envelope);
    state.messageId = undefined;
    state.handoffTarget = event.toAgentId;
  }

  private async finishTurn(envelope: SessionEventEnvelope): Promise<void> {
    const event = envelope.event;
    if (event.type !== "turn-finished") return;
    const state = this.state(envelope);
    if (state.messageId !== undefined) {
      await this.store.finishSessionAssistant(
        envelope.sessionId,
        state.messageId,
        event.status,
      );
    }
    if (envelope.turnId !== undefined) {
      await this.store.finishSessionTurn(envelope.sessionId, envelope.turnId);
      this.turns.delete(envelope.turnId);
    }
  }

  private async applyDurableStream(envelope: SessionEventEnvelope): Promise<void> {
    if (envelope.messageId === undefined) return;
    const stream = agentStreamEventSchema.safeParse(envelope.event);
    if (!stream.success) return;
    await this.store.applySessionStreamEvent(envelope.sessionId, envelope.messageId, stream.data);
  }

  private state(envelope: SessionEventEnvelope): TurnTranscriptState {
    if (envelope.turnId === undefined) throw new Error(`${envelope.event.type} 缺少 turnId`);
    return this.turnState(envelope.turnId);
  }

  private turnState(turnId: string): TurnTranscriptState {
    const existing = this.turns.get(turnId);
    if (existing !== undefined) return existing;
    const created: TurnTranscriptState = {};
    this.turns.set(turnId, created);
    return created;
  }
}

/** 让 journal 写入与 transcript 投影保持同一顺序；transcript 失败不回滚已追加事实。 */
export class TranscriptSessionJournal implements SessionJournal {
  constructor(
    private readonly journal: SessionJournal,
    private readonly bridge: SessionTranscriptBridge,
  ) {}

  async append(
    sessionId: SessionId,
    event: AgentDurableEvent,
    metadata?: SessionJournalAppend,
  ): Promise<SessionEventEnvelope> {
    const envelope = await this.journal.append(sessionId, event, metadata);
    await this.bridge.apply(envelope);
    return envelope;
  }

  readAfter(sessionId: SessionId, sequence: number): Promise<SessionEventEnvelope[]> {
    return this.journal.readAfter(sessionId, sequence);
  }

  lastSequence(sessionId: SessionId): Promise<number> {
    return this.journal.lastSequence(sessionId);
  }

  clear(sessionId: SessionId): Promise<void> {
    return this.journal.clear(sessionId);
  }
}

function isLiveOnly(event: AgentStreamEvent): boolean {
  switch (event.type) {
    case "text-delta":
    case "reasoning-delta":
    case "tool-input-delta":
    case "tool-output-delta":
      return true;
    default:
      return false;
  }
}

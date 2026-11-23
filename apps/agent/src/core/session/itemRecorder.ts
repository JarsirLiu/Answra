/**
 * 条目写入的唯一漏斗：内存视图 → 结算条目 → durable 帧；不判断 Turn 状态机。
 *
 * 顺序是硬约束（Note 第 13.1 节）：`text-end` / `reasoning-end` 的正文只存在于内存 part，
 * 必须先把事件应用到内存视图，再从 part 生成条目；反过来会写出空文本。
 *
 * 内存视图仍是 live 快照的唯一来源；条目是 durable 事实的唯一来源，两者不互相推导。
 */
import { randomUUID } from "node:crypto";
import type { ConversationMessage } from "@answra/shared";
import type {
  AgentStreamEvent,
  SessionFrame,
  SessionItem,
  TurnOutcome,
} from "@answra/shared/schema";
import {
  sessionItemStatusOfTurnOutcome,
  toSessionItemFrame,
  turnEndItemId,
} from "@answra/shared/schema";
import type { SessionItemDraft, SessionItemStore } from "../transcript/itemStore";
import {
  handoffItemDraft,
  type ItemDraftContext,
  streamItemDrafts,
  unsettledItemDrafts,
  userItemDraft,
} from "../transcript/sessionItemDrafts";
import type { ConversationStore } from "../transcript/store";
import type {
  SessionId,
  StepEventRecorder,
  StepStart,
  StoredHandoff,
  TurnFinish,
  TurnRecorder,
  TurnStart,
} from "./contracts";
import type { SessionFrameBus } from "./sessionFrameBus";
import { toLiveFrame } from "./sessionFrameBus";

const DEFAULT_PRODUCER_ID = "answra-agent";
const UNSETTLED_TOOL_ERROR = "Session 结束时工具调用没有结果";

export interface SessionItemRecorderOptions {
  items: SessionItemStore;
  store: ConversationStore;
  frames: SessionFrameBus;
  /** Turn/Step 边界后的权威快照推送；不参与事实写入。 */
  onSnapshot?: (sessionId: SessionId) => void | Promise<void>;
  /** Turn 终态观察口；usage 锚点在这里提交或清理。 */
  onTurnFinished?: (sessionId: SessionId, outcome: TurnOutcome) => void | Promise<void>;
  /** handoff 落库前的 Bot 发现 ACL 校验。 */
  authorizeHandoff?: (sessionId: SessionId, handoff: StoredHandoff) => Promise<void>;
  producerId?: string;
  now?: () => Date;
}

export class SessionItemRecorder implements StepEventRecorder, TurnRecorder {
  private readonly items: SessionItemStore;
  private readonly store: ConversationStore;
  private readonly frames: SessionFrameBus;
  private readonly onSnapshot?: SessionItemRecorderOptions["onSnapshot"];
  private readonly onTurnFinished?: SessionItemRecorderOptions["onTurnFinished"];
  private readonly authorizeHandoff?: SessionItemRecorderOptions["authorizeHandoff"];
  private readonly producerId: string;
  private readonly now: () => Date;
  private readonly knownItemIds = new Map<string, Set<string>>();

  constructor(options: SessionItemRecorderOptions) {
    this.items = options.items;
    this.store = options.store;
    this.frames = options.frames;
    this.onSnapshot = options.onSnapshot;
    this.onTurnFinished = options.onTurnFinished;
    this.authorizeHandoff = options.authorizeHandoff;
    this.producerId = options.producerId ?? DEFAULT_PRODUCER_ID;
    this.now = options.now ?? (() => new Date());
  }

  async recordUserMessage(
    sessionId: SessionId,
    message: ConversationMessage,
    turnId: string,
  ): Promise<void> {
    // 提交即写 durable 事实，但不推进内存视图：排队消息在 Turn 真正开始时才进入 transcript。
    await this.appendDrafts(sessionId, [userItemDraft(message, turnId, this.timestamp())], false);
  }

  /**
   * 没有 Turn 归属的用户消息（面试转写）：内存与条目同时写，
   * 折叠时按首次出现的 `seq` 排进历史。
   */
  async recordStandaloneUserMessage(
    sessionId: SessionId,
    message: ConversationMessage,
  ): Promise<void> {
    await this.appendDrafts(sessionId, [userItemDraft(message, undefined, this.timestamp())]);
  }

  async beginTurn(sessionId: SessionId, turn: TurnStart): Promise<void> {
    const snapshot = await this.store.load(sessionId);
    const persistedInput =
      turn.input !== undefined && snapshot.messages.some((item) => item.id === turn.input?.id);
    await this.store.beginSessionTurn(sessionId, {
      turnId: turn.turnId,
      messageId: turn.messageId,
      authorAgentId: turn.agentId,
      ...(turn.input === undefined || persistedInput ? {} : { userMessage: turn.input }),
      ...(turn.input === undefined || !persistedInput ? {} : { afterMessageId: turn.input.id }),
    });
    await this.items.beginTurn(sessionId, turn.turnId);
    await this.publishSnapshot(sessionId);
  }

  async finishTurn(sessionId: SessionId, turnId: string, finish: TurnFinish): Promise<void> {
    const now = this.timestamp();
    const snapshot = await this.store.load(sessionId);
    const activeMessageId = snapshot.activeMessageId;
    const activeMessage =
      activeMessageId === undefined
        ? undefined
        : snapshot.messages.find((message) => message.id === activeMessageId);

    // 点停止 / 崩溃时正文已在内存里，但 text-end 可能永远不到；先补写未结算 part。
    if (finish.outcome !== "completed" && activeMessage !== undefined && activeMessageId) {
      const drafts = unsettledItemDrafts(
        activeMessage,
        {
          turnId,
          messageId: activeMessageId,
          ...(activeMessage.authorAgentId === undefined
            ? {}
            : { authorAgentId: activeMessage.authorAgentId }),
          createdAt: now,
        },
        await this.itemExists(sessionId),
        finish.errorText ?? UNSETTLED_TOOL_ERROR,
      );
      if (drafts.length > 0) await this.appendDrafts(sessionId, drafts);
    }

    const finished = await this.items.finishTurn(
      sessionId,
      turnId,
      turnEndDraft(turnId, finish, await this.countToolCalls(sessionId, turnId), now),
    );
    await this.publishItems(sessionId, finished.items);

    if (activeMessageId !== undefined) {
      await this.store.finishSessionAssistant(sessionId, activeMessageId, finish.outcome);
    }
    await this.store.finishSessionTurn(sessionId, turnId);
    await this.onTurnFinished?.(sessionId, finish.outcome);
    await this.publishSnapshot(sessionId);
  }

  async cancelQueuedTurn(sessionId: SessionId, turn: TurnStart): Promise<void> {
    const finished = await this.items.finishTurn(
      sessionId,
      turn.turnId,
      turnEndDraft(
        turn.turnId,
        { turnId: turn.turnId, outcome: "aborted", reason: "cancelled" },
        await this.countToolCalls(sessionId, turn.turnId),
        this.timestamp(),
      ),
    );
    await this.publishItems(sessionId, finished.items);
    await this.publishSnapshot(sessionId);
  }

  async recordHandoff(sessionId: SessionId, handoff: StoredHandoff): Promise<void> {
    await this.authorizeHandoff?.(sessionId, handoff);
    const recordId = randomUUID();
    await this.store.finishSessionAssistant(sessionId, handoff.sourceMessageId, "completed");
    await this.store.appendHandoffMessage(sessionId, {
      id: recordId,
      fromAgentId: handoff.fromAgentId,
      toAgentId: handoff.toAgentId,
      task: handoff.task,
    });
    await this.store.beginSessionAssistant(sessionId, handoff.nextMessageId, handoff.toAgentId);
    await this.appendDrafts(sessionId, [
      handoffItemDraft(
        {
          id: recordId,
          fromAgentId: handoff.fromAgentId,
          toAgentId: handoff.toAgentId,
          task: handoff.task,
        },
        handoff.turnId,
        this.timestamp(),
      ),
    ]);
    await this.publishSnapshot(sessionId);
  }

  async appendDrafts(
    sessionId: SessionId,
    drafts: readonly SessionItemDraft[],
    publish = true,
  ): Promise<void> {
    if (drafts.length === 0) return;
    const appended = await this.items.appendItems(sessionId, drafts);
    await this.publishItems(sessionId, appended.items, publish);
  }

  /** `StepEventRecorder` 的实现：先写内存视图，再按事件结算条目。 */
  async append(step: StepStart, event: AgentStreamEvent): Promise<void> {
    await this.store.applySessionStreamEvent(step.sessionId, step.messageId, event);
    const live = toLiveFrame(step, event);
    if (live !== undefined) {
      this.frames.publishLive(live);
      return;
    }
    const snapshot = await this.store.load(step.sessionId);
    const message = snapshot.messages.find((item) => item.id === step.messageId);
    if (message === undefined) return;
    const drafts = streamItemDrafts(
      message,
      event,
      {
        turnId: step.turnId,
        messageId: step.messageId,
        authorAgentId: step.agentId,
        createdAt: this.timestamp(),
      },
      await this.itemExists(step.sessionId),
    );
    await this.appendDrafts(step.sessionId, drafts);
  }

  async readFramesAfter(sessionId: SessionId, afterSeq: number): Promise<SessionFrame[]> {
    const items = await this.items.readItems(sessionId, { afterSeq });
    return items.map((item) => toSessionItemFrame(sessionId, item, this.producerId));
  }

  async lastSeq(sessionId: SessionId): Promise<number> {
    const cursor = await this.items.readCursor(sessionId);
    return cursor === undefined ? 0 : cursor.nextSeq - 1;
  }

  /** 清空条目并丢弃缓存；调用方仍负责清空内存视图。 */
  async clear(sessionId: SessionId): Promise<void> {
    await this.items.clear(sessionId);
    this.knownItemIds.delete(sessionId);
  }

  private async publishItems(
    sessionId: SessionId,
    items: readonly SessionItem[],
    publish = true,
  ): Promise<void> {
    if (items.length === 0) return;
    const known = await this.knownItems(sessionId);
    for (const item of items) {
      known.add(item.itemId);
      if (publish) this.frames.publish(toSessionItemFrame(sessionId, item, this.producerId));
    }
    const last = items[items.length - 1];
    if (last !== undefined) await this.store.advanceLastSeq(sessionId, last.seq);
  }

  private async itemExists(sessionId: SessionId): Promise<(itemId: string) => boolean> {
    const known = await this.knownItems(sessionId);
    return (itemId) => known.has(itemId);
  }

  private async knownItems(sessionId: SessionId): Promise<Set<string>> {
    const cached = this.knownItemIds.get(sessionId);
    if (cached !== undefined) return cached;
    const items = await this.items.readItems(sessionId);
    const known = new Set(items.map((item) => item.itemId));
    this.knownItemIds.set(sessionId, known);
    return known;
  }

  private async publishSnapshot(sessionId: SessionId): Promise<void> {
    if (this.onSnapshot !== undefined) await this.onSnapshot(sessionId);
  }

  private async countToolCalls(sessionId: SessionId, turnId: string): Promise<number> {
    const items = await this.items.readItems(sessionId);
    return items.filter((item) => item.turnId === turnId && item.payload.kind === "tool-call")
      .length;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function turnEndDraft(
  turnId: string,
  finish: TurnFinish,
  toolCalls: number,
  now: string,
): SessionItemDraft {
  return {
    itemId: turnEndItemId(turnId),
    status: sessionItemStatusOfTurnOutcome(finish.outcome),
    createdAt: now,
    turnId,
    payload: {
      kind: "turn-end",
      ...(finish.finishReason === undefined ? {} : { finishReason: finish.finishReason }),
      ...(finish.reason === undefined ? {} : { reason: finish.reason }),
      stepCount: finish.steps ?? 0,
      toolCalls,
      ...(finish.usage === undefined ? {} : { usage: finish.usage }),
      ...(finish.durationMs === undefined ? {} : { durationMs: finish.durationMs }),
      ...(finish.errorText === undefined ? {} : { errorText: finish.errorText }),
      ...(finish.outcome === "aborted"
        ? // aborted 只有「手动取消」一个来源（Scheduler 强制改判），所以中断原因恒为 cancelled；
          // 其它归因（handoff-failed / context-exhausted）写在 payload.reason，不在这里重复。
          { interruption: { reason: "cancelled" as const, at: now } }
        : {}),
    },
  };
}

export type { ItemDraftContext };

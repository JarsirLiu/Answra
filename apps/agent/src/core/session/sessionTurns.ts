/**
 * 条目 → Turn 投影与崩溃恢复计划：纯函数，不读库、不写库、不分配 `seq`。
 *
 * 运行状态（队列、活动 Turn、步数、压缩）只存在内存；这里只从条目还原
 * 「已经发生过什么」，以及崩溃后必须补写的收口条目。契约见 Note 第 13.1 / 13.4 节。
 *
 * 两个前提由写入侧保证，这里不再猜：
 * - 用户 Turn 的 `turn_id` 就是 user 条目的 `itemId`（提交时同值写入）；
 * - 没有 `turn-end` 的 Turn 只有两种合法解释：只有 user 条目（可续跑），
 *   或进程在产出内容后退出（必须收口）。
 */
import type { ConversationMessage } from "@answra/shared";
import {
  type SessionItem,
  type SessionItemInterruption,
  type TurnFinishReason,
  type TurnSource,
  type TurnStatus,
  toolResultItemId,
  turnEndItemId,
} from "@answra/shared/schema";
import type { SessionItemDraft } from "../transcript/itemStore";
import { createUserMessage } from "../transcript/message";
import type { SessionId, TurnId, TurnProjection } from "./contracts";
import { turnId as asTurnId } from "./contracts";

/** 恢复时唯一的补写原因；崩溃退出是 `process-exit` 的同义词。 */
const RECOVERED_TOOL_ERROR = "Session 恢复时发现工具调用没有结果";
const INTERRUPTED_BY_PROCESS_EXIT: SessionItemInterruption["reason"] = "process-exit";

/**
 * 条目里没有 Bot 身份与 Turn 来源：user 条目按 schema 不携带作者，
 * 来源也不在条目中。恢复 / 投影必须由所属领域注入默认值，不能从内容推演。
 */
export interface SessionTurnDefaults {
  agentId: string;
  source: TurnSource;
}

/** 同一 Turn 的条目集合；只含带 `turnId` 的条目，按 `seq` 排序。 */
export interface SessionTurnGroup {
  turnId: TurnId;
  items: readonly SessionItem[];
  /** 该 Turn 第一条条目的写入时间。 */
  createdAt: string;
  userItem?: SessionItem;
  turnEnd?: SessionItem;
  /** `text` / `reasoning` / `tool-call` / `tool-result`；不含 `user` 与 `turn-end`。 */
  assistantItems: readonly SessionItem[];
}

export interface ProjectedSessionTurns {
  /** 会话已写入的最后一个 `seq`；空会话为 0。 */
  sequence: number;
  turns: readonly TurnProjection[];
  /** 没有 `turn-end` 且没有任何内容条目：崩溃后可安全重新入队。 */
  pending: readonly TurnId[];
  /** 正在执行的 Turn；只有它能解释「缺少 turn-end」。 */
  activeTurnId?: TurnId;
}

export interface SessionTurnRecoveryPlan {
  /** 需要补写的收口条目；调用方用一次 `appendItems` 写入。 */
  closeItems: readonly SessionItemDraft[];
  /** 只有 user 条目、崩溃前没有产出任何内容的 Turn。 */
  pending: readonly TurnId[];
  /** 本次收口的 Turn id，按首条条目的 `seq` 排序。 */
  closedTurnIds: readonly TurnId[];
}

/** 按 `turnId` 分组；没有 `turnId` 的条目（面试转写、迁移历史）不进入任何 Turn。 */
export function groupSessionTurns(items: readonly SessionItem[]): readonly SessionTurnGroup[] {
  const ordered = [...items].sort((left, right) => left.seq - right.seq);
  const groups = new Map<string, SessionItem[]>();
  for (const item of ordered) {
    if (item.turnId === undefined) continue;
    const group = groups.get(item.turnId);
    if (group === undefined) groups.set(item.turnId, [item]);
    else group.push(item);
  }
  const result: SessionTurnGroup[] = [];
  for (const [id, group] of groups) {
    result.push(buildGroup(asTurnId(id), group));
  }
  return result;
}

/**
 * 从条目还原 Turn 列表；补齐恢复后 Scheduler 需要的最小投影。
 *
 * - 有 `turn-end`：状态取收口条目（`complete→completed`、`failed→failed`、`interrupted→aborted`）；
 * - 没有且只有 user 条目：按 `queued`，重启后可以安全重新入队（即便 `openTurnId` 仍指向它，
 *   也说明崩溃发生在产出任何内容之前）；
 * - 没有但有内容且正是 `openTurnId`：按 `running`；
 * - 没有但有内容且不是 `openTurnId`：按 `aborted`（进程已退出，恢复时会补 `turn-end`）。
 */
export function projectSessionTurns(
  sessionId: SessionId,
  items: readonly SessionItem[],
  options: { openTurnId?: string; defaults: SessionTurnDefaults },
): ProjectedSessionTurns {
  const groups = groupSessionTurns(items);
  const turns: TurnProjection[] = [];
  const pending: TurnId[] = [];
  let activeTurnId: TurnId | undefined;
  let sequence = 0;
  for (const item of items) if (item.seq > sequence) sequence = item.seq;

  for (const group of groups) {
    const isOpen = options.openTurnId === group.turnId;
    const status = turnStatusOf(group, isOpen);
    if (status === "queued") pending.push(group.turnId);
    if (status === "running") activeTurnId = group.turnId;
    turns.push(projectGroup(sessionId, group, status, options.defaults));
  }

  return {
    sequence,
    turns,
    pending,
    ...(activeTurnId === undefined ? {} : { activeTurnId }),
  };
}

/**
 * 崩溃恢复：为「已经产出内容但没有 `turn-end`」的 Turn 补收口条目。
 *
 * 缺失的 `tool-result` 必须先补：折叠遇到孤儿 `tool-call` 会把工具 part 折成
 * `interrupted`，但模型历史仍会拿到一条没有结果的调用，下一次请求可能被拒。
 *
 * 幂等：第二次执行时这些 Turn 已有 `turn-end`，不再产出任何条目。
 */
export function planSessionRecovery(
  items: readonly SessionItem[],
  now: string,
): SessionTurnRecoveryPlan {
  const closeItems: SessionItemDraft[] = [];
  const pending: TurnId[] = [];
  const closedTurnIds: TurnId[] = [];

  for (const group of groupSessionTurns(items)) {
    if (group.turnEnd !== undefined) continue;
    if (group.assistantItems.length === 0) {
      pending.push(group.turnId);
      continue;
    }
    closedTurnIds.push(group.turnId);
    const resolved = resolvedToolCallIds(group);
    for (const item of group.assistantItems) {
      if (item.payload.kind !== "tool-call") continue;
      if (resolved.has(item.payload.toolCallId)) continue;
      closeItems.push(recoveredToolResult(item, group.turnId, now));
    }
    closeItems.push(recoveredTurnEnd(group, now));
  }

  return { closeItems, pending, closedTurnIds };
}

function buildGroup(id: TurnId, items: readonly SessionItem[]): SessionTurnGroup {
  const first = items[0];
  if (first === undefined) throw new Error(`Turn 分组为空：${id}`);
  const userItem = items.find((item) => item.payload.kind === "user");
  const turnEnd = items.find((item) => item.payload.kind === "turn-end");
  const assistantItems = items.filter(isAssistantItem);
  return {
    turnId: id,
    items,
    createdAt: first.createdAt,
    ...(userItem === undefined ? {} : { userItem }),
    ...(turnEnd === undefined ? {} : { turnEnd }),
    assistantItems,
  };
}

function isAssistantItem(item: SessionItem): boolean {
  return item.payload.kind !== "user" && item.payload.kind !== "turn-end";
}

function turnStatusOf(group: SessionTurnGroup, isOpen: boolean): TurnStatus {
  if (group.turnEnd !== undefined) return turnEndStatus(group.turnEnd);
  if (group.assistantItems.length === 0) return "queued";
  return isOpen ? "running" : "aborted";
}

function turnEndStatus(item: SessionItem): TurnStatus {
  if (item.status === "complete") return "completed";
  return item.status === "failed" ? "failed" : "aborted";
}

function projectGroup(
  sessionId: SessionId,
  group: SessionTurnGroup,
  status: TurnStatus,
  defaults: SessionTurnDefaults,
): TurnProjection {
  const assistantMessageIds = messageIdsOf(group.assistantItems);
  const authorAgentId = firstAuthor(group.assistantItems);
  const lastAuthor = lastAuthorAgentId(group.assistantItems);
  const turnEnd = group.turnEnd;
  const input = group.userItem === undefined ? undefined : userMessageOf(group.userItem);
  const finishReason = finishReasonOf(group, status);
  const errorText = turnEnd?.payload.kind === "turn-end" ? turnEnd.payload.errorText : undefined;

  return {
    sessionId,
    turnId: group.turnId,
    source: defaults.source,
    status,
    agentId: authorAgentId ?? defaults.agentId,
    ...(lastAuthor === undefined ? {} : { activeAgentId: lastAuthor }),
    ...(input === undefined ? {} : { input }),
    assistantMessageIds,
    handoffCount: handoffCountOf(group.assistantItems),
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(errorText === undefined ? {} : { errorText }),
    createdAt: group.createdAt,
    ...(group.assistantItems[0] === undefined
      ? {}
      : { startedAt: group.assistantItems[0].createdAt }),
    ...(turnEnd === undefined ? {} : { finishedAt: turnEnd.createdAt }),
  };
}

function messageIdsOf(items: readonly SessionItem[]): readonly string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (item.messageId === undefined) continue;
    if (!ids.includes(item.messageId)) ids.push(item.messageId);
  }
  return ids;
}

function handoffCountOf(items: readonly SessionItem[]): number {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.audienceAgentId === undefined || item.messageId === undefined) continue;
    ids.add(item.messageId);
  }
  return ids.size;
}

function firstAuthor(items: readonly SessionItem[]): string | undefined {
  for (const item of items) if (item.authorAgentId !== undefined) return item.authorAgentId;
  return undefined;
}

function lastAuthorAgentId(items: readonly SessionItem[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const author = items[index]?.authorAgentId;
    if (author !== undefined) return author;
  }
  return undefined;
}

function finishReasonOf(group: SessionTurnGroup, status: TurnStatus): TurnFinishReason | undefined {
  if (group.turnEnd?.payload.kind === "turn-end") {
    const reason = group.turnEnd.payload.reason;
    if (reason !== undefined) return reason;
    const interruption = group.turnEnd.payload.interruption;
    if (interruption !== undefined) {
      return interruption.reason === "cancelled" ? "cancelled" : "interrupted";
    }
  }
  if (status === "completed") return "completed";
  if (status === "aborted") return "cancelled";
  if (status === "failed") return "unknown";
  return undefined;
}

function userMessageOf(item: SessionItem): ConversationMessage {
  if (item.payload.kind !== "user") throw new Error(`不是 user 条目：${item.itemId}`);
  return createUserMessage(item.itemId, {
    text: item.payload.text,
    images: item.payload.images,
  });
}

function resolvedToolCallIds(group: SessionTurnGroup): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const item of group.assistantItems) {
    if (item.payload.kind === "tool-result") ids.add(item.payload.toolCallId);
  }
  return ids;
}

function recoveredToolResult(
  call: SessionItem,
  groupTurnId: TurnId,
  now: string,
): SessionItemDraft {
  if (call.payload.kind !== "tool-call") throw new Error(`不是 tool-call 条目：${call.itemId}`);
  if (call.messageId === undefined) throw new Error(`tool-call 条目缺少 messageId：${call.itemId}`);
  return {
    itemId: toolResultItemId(call.payload.toolCallId),
    status: "complete",
    createdAt: now,
    turnId: groupTurnId,
    messageId: call.messageId,
    ...(call.authorAgentId === undefined ? {} : { authorAgentId: call.authorAgentId }),
    payload: {
      kind: "tool-result",
      toolCallId: call.payload.toolCallId,
      outcome: "error",
      errorText: RECOVERED_TOOL_ERROR,
    },
  };
}

function recoveredTurnEnd(group: SessionTurnGroup, now: string): SessionItemDraft {
  return {
    itemId: turnEndItemId(group.turnId),
    status: "interrupted",
    createdAt: now,
    turnId: group.turnId,
    payload: {
      kind: "turn-end",
      reason: "interrupted",
      // 崩溃前没有落过任何 step 事实：步数不可知，按迁移同样的口径记 0。
      stepCount: 0,
      toolCalls: group.assistantItems.filter((item) => item.payload.kind === "tool-call").length,
      interruption: { reason: INTERRUPTED_BY_PROCESS_EXIT, at: now },
    },
  };
}

/**
 * 条目 → 对话消息的折叠：纯函数，不读库、不推演时序。
 *
 * 所有「运行中 / 已中断」判断只来自两处输入：条目的终态字段与会话行的 `openTurnId`。
 * 不按时间、不按「最后一条像什么」猜状态；同一条目序列永远折出同一结果。
 */

import type { ConversationMessage, ConversationMessagePart } from "../conversation";
import type { AgentMessageState, AgentToolCallState } from "../status";
import type { SessionItem, SessionItemPayload, SessionItemStatus } from "./item";

export interface FoldSessionItemsOptions {
  /** 会话当前正在执行的 Turn；只有它能把「没有 turn-end」解释成运行中。 */
  openTurnId?: string;
}

/**
 * Turn 在折叠时的相位：`unattributed` 表示条目本身没有 Turn（迁移来的历史消息）。
 *
 * 没有 `turn-end` 且不是 `openTurnId` 的 Turn 一律按 `interrupted`，
 * 这是进程在 Turn 中途退出的唯一合法解释。
 */
type TurnPhase = "open" | "complete" | "failed" | "interrupted" | "unattributed";

interface FoldContext {
  turnPhases: ReadonlyMap<string, TurnPhase>;
  /** 每个 Turn 里 seq 最大的 assistant 消息；只有它承载 Turn 终态。 */
  lastAssistantByTurn: ReadonlyMap<string, string>;
}

interface AssistantDraft {
  id: string;
  firstSeq: number;
  turnId?: string;
  authorAgentId?: string;
  audienceAgentId?: string;
  parts: ConversationMessagePart[];
  toolIndexes: Map<string, number>;
  resolvedToolCalls: Set<string>;
}

/**
 * 把条目折回消息；输入不必有序，先按 `seq` 排序。
 *
 * - 消息按首次出现的 `seq` 排序；同一 `message_id` 的 part 按各自 `seq` 排列。
 * - `message.text` 与 `reasoning` 都是对应 part 的无分隔拼接，和内存视图的累积方式一致。
 * - 每个 Turn 只有最后一条 assistant 消息承载 Turn 终态；更早的消息在写入时就已经是终态。
 */
export function foldSessionItems(
  items: readonly SessionItem[],
  options: FoldSessionItemsOptions = {},
): ConversationMessage[] {
  const ordered = [...items].sort((left, right) => left.seq - right.seq);
  const context = foldContext(ordered, options.openTurnId);
  const drafts = new Map<string, AssistantDraft>();
  const entries: Array<{ seq: number; message: ConversationMessage }> = [];

  for (const item of ordered) {
    if (item.payload.kind === "turn-end") continue;
    if (item.payload.kind === "user") {
      entries.push({ seq: item.seq, message: userMessageOf(item, item.payload) });
      continue;
    }
    applyItem(ensureDraft(drafts, item), item);
  }

  for (const draft of drafts.values()) {
    entries.push({ seq: draft.firstSeq, message: assistantMessageOf(draft, context) });
  }

  return entries.sort((left, right) => left.seq - right.seq).map((entry) => entry.message);
}

function foldContext(ordered: readonly SessionItem[], openTurnId: string | undefined): FoldContext {
  const turnPhases = new Map<string, TurnPhase>();
  const lastAssistantByTurn = new Map<string, string>();

  for (const item of ordered) {
    if (item.payload.kind === "turn-end") {
      turnPhases.set(requireTurnId(item), item.status);
      continue;
    }
    if (item.payload.kind === "user") continue;
    if (item.turnId !== undefined && item.messageId !== undefined)
      lastAssistantByTurn.set(item.turnId, item.messageId);
  }

  // 没有 turn-end 的 Turn 只有「仍是 openTurnId」才算运行中，其余按中断处理。
  if (openTurnId !== undefined && !turnPhases.has(openTurnId)) turnPhases.set(openTurnId, "open");

  return { turnPhases, lastAssistantByTurn };
}

function turnPhaseOf(turnId: string | undefined, context: FoldContext): TurnPhase {
  if (turnId === undefined) return "unattributed";
  return context.turnPhases.get(turnId) ?? "interrupted";
}

type UserItemPayload = Extract<SessionItemPayload, { kind: "user" }>;

function userMessageOf(item: SessionItem, payload: UserItemPayload): ConversationMessage {
  return {
    id: item.itemId,
    role: "user",
    audience: { kind: "user" },
    text: payload.text,
    images: payload.images.map((image) => ({ ...image })),
    status: "complete",
    parts: [],
  };
}

function ensureDraft(drafts: Map<string, AssistantDraft>, item: SessionItem): AssistantDraft {
  const messageId = requireMessageId(item);
  const existing = drafts.get(messageId);
  if (existing !== undefined) {
    if (existing.turnId === undefined && item.turnId !== undefined) existing.turnId = item.turnId;
    if (existing.authorAgentId === undefined) existing.authorAgentId = item.authorAgentId;
    if (existing.audienceAgentId === undefined) existing.audienceAgentId = item.audienceAgentId;
    return existing;
  }
  const draft: AssistantDraft = {
    id: messageId,
    firstSeq: item.seq,
    ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
    ...(item.authorAgentId === undefined ? {} : { authorAgentId: item.authorAgentId }),
    ...(item.audienceAgentId === undefined ? {} : { audienceAgentId: item.audienceAgentId }),
    parts: [],
    toolIndexes: new Map(),
    resolvedToolCalls: new Set(),
  };
  drafts.set(messageId, draft);
  return draft;
}

function applyItem(draft: AssistantDraft, item: SessionItem): void {
  const payload = item.payload;
  switch (payload.kind) {
    case "text":
    case "reasoning":
      draft.parts.push({
        id: item.itemId,
        kind: payload.kind,
        text: payload.text,
        state: partStateOf(item.status),
      });
      return;
    case "tool-call":
      draft.toolIndexes.set(payload.toolCallId, draft.parts.length);
      draft.parts.push({
        id: item.itemId,
        kind: "tool",
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        ...(payload.title === undefined ? {} : { title: payload.title }),
        ...(payload.inputText === undefined ? {} : { inputText: payload.inputText }),
        ...(payload.input === undefined ? {} : { input: payload.input }),
        state: "pending",
      });
      return;
    case "tool-result": {
      const index = draft.toolIndexes.get(payload.toolCallId);
      const part = index === undefined ? undefined : draft.parts[index];
      if (index === undefined || part?.kind !== "tool")
        throw new Error(`tool-result 没有对应的 tool-call：${item.itemId}`);
      draft.parts[index] = {
        ...part,
        state: toolStateOf(payload.outcome),
        ...(payload.outcome === "output" ? { output: payload.output } : {}),
        ...(payload.outcome === "error" ? { errorText: payload.errorText } : {}),
      };
      draft.resolvedToolCalls.add(payload.toolCallId);
      return;
    }
    case "user":
    case "turn-end":
      return;
  }
}

function assistantMessageOf(draft: AssistantDraft, context: FoldContext): ConversationMessage {
  const phase = turnPhaseOf(draft.turnId, context);
  const parts = draft.parts.map((part) => {
    if (part.kind !== "tool" || draft.resolvedToolCalls.has(part.toolCallId)) return part;
    return { ...part, state: unresolvedToolState(phase) };
  });
  const reasoning = joinParts(parts, "reasoning");
  return {
    id: draft.id,
    role: "assistant",
    ...(draft.authorAgentId === undefined ? {} : { authorAgentId: draft.authorAgentId }),
    audience:
      draft.audienceAgentId === undefined
        ? { kind: "user" }
        : { kind: "bot", agentId: draft.audienceAgentId },
    text: joinParts(parts, "text"),
    images: [],
    status: messageStatusOf(draft, parts, phase, context),
    parts,
    ...(reasoning ? { reasoning } : {}),
  };
}

/**
 * 只有该 Turn 的最后一条 assistant 消息承载 Turn 终态；更早的消息看自己的 part。
 *
 * 这条规则来自运行时的唯一 writer：一个 Turn 同时只有一条活动消息，
 * 交接消息在写交接事件时就已经是 `complete`。
 */
function messageStatusOf(
  draft: AssistantDraft,
  parts: readonly ConversationMessagePart[],
  phase: TurnPhase,
  context: FoldContext,
): AgentMessageState {
  const isLastOfTurn =
    draft.turnId !== undefined && context.lastAssistantByTurn.get(draft.turnId) === draft.id;
  if (isLastOfTurn && phase !== "unattributed") return phase === "open" ? "streaming" : phase;
  if (parts.some((part) => part.state === "failed")) return "failed";
  if (parts.some((part) => part.state === "interrupted")) return "interrupted";
  return "complete";
}

function unresolvedToolState(phase: TurnPhase): AgentToolCallState {
  if (phase === "open") return "running";
  if (phase === "failed") return "failed";
  return "interrupted";
}

function partStateOf(status: SessionItemStatus): "completed" | "failed" | "interrupted" {
  return status === "complete" ? "completed" : status;
}

function toolStateOf(outcome: "output" | "error" | "denied"): "completed" | "failed" | "denied" {
  if (outcome === "output") return "completed";
  return outcome === "error" ? "failed" : "denied";
}

/** 正文与思考都是无分隔拼接，和内存视图逐 delta 累加的结果一致。 */
function joinParts(parts: readonly ConversationMessagePart[], kind: "text" | "reasoning"): string {
  let text = "";
  for (const part of parts) if (part.kind === kind) text += part.text;
  return text;
}

function requireTurnId(item: SessionItem): string {
  if (item.turnId === undefined) throw new Error(`turn-end 条目缺少 turnId：${item.itemId}`);
  return item.turnId;
}

function requireMessageId(item: SessionItem): string {
  if (item.messageId === undefined) throw new Error(`条目缺少 messageId：${item.itemId}`);
  return item.messageId;
}

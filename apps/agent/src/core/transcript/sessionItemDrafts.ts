/**
 * 内存消息 + 模型流事件 → 条目草稿：纯函数，不读库、不分配 `seq`。
 *
 * 写入时机见 Note 第 13.1 节：只有 part / 工具结算时才产出条目，delta 不落库。
 * `text-end` / `reasoning-end` 的正文不在事件里，必须由结算后的内存 part 提供，
 * 因此调用方必须先更新内存视图再调用这里。
 */
import type { ConversationMessage, ConversationMessagePart } from "@answra/shared";
import type { AgentStreamEvent } from "@answra/shared/schema";
import { toolResultItemId } from "@answra/shared/schema";
import type { SessionItemDraft } from "./itemStore";

/** 条目的路由字段；`turnId` 缺省表示没有 Turn 归属（面试转写、迁移历史）。 */
export interface ItemDraftContext {
  turnId?: string;
  messageId: string;
  authorAgentId?: string;
  createdAt: string;
}

/** 判断条目是否已写入；结果条目必须等对应 `tool-call` 存在才落库，避免折叠时悬挂。 */
export type ItemExists = (itemId: string) => boolean;

/** 用户消息的条目：`item_id` 就是消息 id，且不携带 `messageId` 列。 */
export function userItemDraft(
  message: ConversationMessage,
  turnId: string | undefined,
  createdAt: string,
): SessionItemDraft {
  if (message.role !== "user") throw new Error("只有用户消息能写 user 条目");
  return {
    itemId: message.id,
    status: "complete",
    createdAt,
    ...(turnId === undefined ? {} : { turnId }),
    payload: {
      kind: "user",
      text: message.text,
      images: message.images.map((image) => ({ ...image })),
    },
  };
}

/**
 * 一条模型流事件产出的条目；非结算事件返回空数组。
 *
 * `tool-execution-finished` 与 `tool-result` 都映射到同一个 `tool-result` 条目，
 * 第二条命中唯一约束即 no-op，所以这里不判断「哪条更权威」。
 */
export function streamItemDrafts(
  message: ConversationMessage,
  event: AgentStreamEvent,
  context: ItemDraftContext,
  hasItem: ItemExists,
): SessionItemDraft[] {
  switch (event.type) {
    case "text-end":
      return partItemDrafts(message, event.partId, "text", context);
    case "reasoning-end":
      return partItemDrafts(message, event.partId, "reasoning", context);
    case "tool-call": {
      const part = toolPartOf(message, event.toolCallId);
      return [
        {
          itemId: event.toolCallId,
          status: "complete",
          createdAt: context.createdAt,
          messageId: context.messageId,
          ...turnAuthorOf(context),
          payload: {
            kind: "tool-call",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            ...(part?.title === undefined ? {} : { title: part.title }),
            ...(part?.inputText === undefined ? {} : { inputText: part.inputText }),
            input: event.input,
          },
        },
      ];
    }
    case "tool-execution-finished":
      return toolResultDrafts(event.toolCallId, context, hasItem, {
        outcome: event.result.success ? "output" : "error",
        ...(event.result.success ? { output: event.result.output } : {}),
        ...(event.result.success ? {} : { errorText: event.result.errorText }),
        durationMs: event.durationMs,
      });
    case "tool-result":
      return toolResultDrafts(event.toolCallId, context, hasItem, {
        outcome: "output",
        output: event.output,
      });
    case "tool-error":
      return toolResultDrafts(event.toolCallId, context, hasItem, {
        outcome: "error",
        errorText: event.errorText,
      });
    case "tool-output-denied":
      return toolResultDrafts(event.toolCallId, context, hasItem, { outcome: "denied" });
    default:
      return [];
  }
}

/**
 * Turn 收口时补写「内存里已有、库里还没有终态」的 part。
 *
 * 点停止时文本已经在内存里累积，但 `text-end` 可能永远不到；崩溃时同理。
 * 工具只要 `tool-call` 已经落库，就必须补一条 `tool-result`，否则下一次模型请求被拒。
 */
export function unsettledItemDrafts(
  message: ConversationMessage,
  context: ItemDraftContext,
  hasItem: ItemExists,
  reasonText: string,
): SessionItemDraft[] {
  const drafts: SessionItemDraft[] = [];
  for (const part of message.parts ?? []) {
    if (part.kind === "tool") {
      // 调用条目都没写成，历史里就不存在这次调用，不需要补结果。
      if (!hasItem(part.toolCallId)) continue;
      if (hasItem(toolResultItemId(part.toolCallId))) continue;
      const result = toolResultDraft(part.toolCallId, context, hasItem, {
        outcome: "error",
        errorText: reasonText,
      });
      if (result !== undefined) drafts.push(result);
      continue;
    }
    if (part.state === "completed" || part.state === "failed" || part.state === "interrupted")
      continue;
    drafts.push({
      itemId: part.id,
      status: "interrupted",
      createdAt: context.createdAt,
      messageId: context.messageId,
      ...turnAuthorOf(context),
      payload: { kind: part.kind, text: part.text },
    });
  }
  return drafts;
}

/** 交接消息本身是一条 `text` 条目：作者是来源 Bot，接收方是目标 Bot。 */
export function handoffItemDraft(
  handoff: { id: string; fromAgentId: string; toAgentId: string; task: string },
  turnId: string | undefined,
  createdAt: string,
): SessionItemDraft {
  return {
    itemId: `${handoff.id}:text`,
    status: "complete",
    createdAt,
    messageId: handoff.id,
    ...(turnId === undefined ? {} : { turnId }),
    authorAgentId: handoff.fromAgentId,
    audienceAgentId: handoff.toAgentId,
    payload: { kind: "text", text: handoff.task },
  };
}

function partItemDrafts(
  message: ConversationMessage,
  partId: string,
  kind: "text" | "reasoning",
  context: ItemDraftContext,
): SessionItemDraft[] {
  const part = (message.parts ?? []).find((candidate) => candidate.id === partId);
  if (part === undefined || part.kind !== kind) return [];
  return [
    {
      itemId: part.id,
      status: itemStatusOf(part),
      createdAt: context.createdAt,
      messageId: context.messageId,
      ...turnAuthorOf(context),
      payload: { kind, text: part.text },
    },
  ];
}

interface ToolResultFacts {
  outcome: "output" | "error" | "denied";
  output?: unknown;
  errorText?: string;
  durationMs?: number;
}

function toolResultDrafts(
  toolCallId: string,
  context: ItemDraftContext,
  hasItem: ItemExists,
  facts: ToolResultFacts,
): SessionItemDraft[] {
  const draft = toolResultDraft(toolCallId, context, hasItem, facts);
  return draft === undefined ? [] : [draft];
}

function toolResultDraft(
  toolCallId: string,
  context: ItemDraftContext,
  hasItem: ItemExists,
  facts: ToolResultFacts,
): SessionItemDraft | undefined {
  // 没有对应的 tool-call 时宁可不写：折叠遇到孤儿结果会 fail-closed 到整条会话读不出。
  if (!hasItem(toolCallId)) return undefined;
  return {
    itemId: toolResultItemId(toolCallId),
    status: "complete",
    createdAt: context.createdAt,
    messageId: context.messageId,
    ...turnAuthorOf(context),
    payload: {
      kind: "tool-result",
      toolCallId,
      outcome: facts.outcome,
      ...(facts.output === undefined ? {} : { output: facts.output }),
      ...(facts.errorText === undefined ? {} : { errorText: facts.errorText }),
      ...(facts.durationMs === undefined ? {} : { durationMs: facts.durationMs }),
    },
  };
}

function turnAuthorOf(context: ItemDraftContext): {
  turnId?: string;
  authorAgentId?: string;
} {
  return {
    ...(context.turnId === undefined ? {} : { turnId: context.turnId }),
    ...(context.authorAgentId === undefined ? {} : { authorAgentId: context.authorAgentId }),
  };
}

function toolPartOf(
  message: ConversationMessage,
  toolCallId: string,
): Extract<ConversationMessagePart, { kind: "tool" }> | undefined {
  const part = (message.parts ?? []).find(
    (candidate) => candidate.kind === "tool" && candidate.toolCallId === toolCallId,
  );
  return part?.kind === "tool" ? part : undefined;
}

function itemStatusOf(
  part: Extract<ConversationMessagePart, { kind: "text" | "reasoning" }>,
): "complete" | "failed" | "interrupted" {
  if (part.state === "completed") return "complete";
  if (part.state === "failed") return "failed";
  return "interrupted";
}

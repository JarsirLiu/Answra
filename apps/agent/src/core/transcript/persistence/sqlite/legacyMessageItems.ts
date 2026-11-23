/**
 * 旧 JSON 会话消息 → 只追加条目；只在一次性导入时使用。
 *
 * 规则与 P1 迁移回填保持一致：以用户消息为 Turn 边界，Turn 末尾补 `turn-end`；
 * 工具 part 拆成 `tool-call` 与（已结算时的）`tool-result`。
 */
import type { ConversationMessage, ConversationMessagePart } from "@answra/shared";
import type { SessionItemStatus } from "@answra/shared/schema";
import type { SessionItemDraft } from "../../itemStore";

interface ItemBase {
  turnId: string;
  messageId?: string;
  authorAgentId?: string;
  audienceAgentId?: string;
}

export interface LegacyItemImport {
  items: readonly SessionItemDraft[];
  /** 消息条数，只统计真正写出条目的消息。 */
  messageCount: number;
}

export function legacyMessagesToItems(
  messages: readonly ConversationMessage[],
  createdAt: string,
): LegacyItemImport {
  const drafts: SessionItemDraft[] = [];
  let messageCount = 0;
  let current:
    | {
        turnId: string;
        messages: Array<{ message: ConversationMessage; items: SessionItemDraft[] }>;
      }
    | undefined;

  const flush = () => {
    if (current === undefined) return;
    drafts.push(turnEndItem(current.turnId, current.messages, createdAt));
    current = undefined;
  };

  for (const message of messages) {
    if (message.role === "user") {
      flush();
      current = { turnId: message.id, messages: [] };
    } else if (current === undefined) {
      current = { turnId: `opening:${message.id}`, messages: [] };
    }
    const base = itemBase(current.turnId, message);
    const items = expandMessage(base, message, createdAt);
    if (items.length === 0) continue;
    current.messages.push({ message, items });
    messageCount += 1;
    drafts.push(...items);
  }
  flush();
  return { items: drafts, messageCount };
}

function itemBase(turnId: string, message: ConversationMessage): ItemBase {
  if (message.role === "user") return { turnId };
  return {
    turnId,
    messageId: message.id,
    ...(message.authorAgentId === undefined ? {} : { authorAgentId: message.authorAgentId }),
    ...(message.audience?.kind === "bot" ? { audienceAgentId: message.audience.agentId } : {}),
  };
}

function expandMessage(
  base: ItemBase,
  message: ConversationMessage,
  createdAt: string,
): SessionItemDraft[] {
  if (message.role === "user") {
    return [
      {
        itemId: message.id,
        status: "complete",
        createdAt,
        turnId: base.turnId,
        payload: {
          kind: "user",
          text: message.text,
          images: message.images.map((image) => ({ ...image })),
        },
      },
    ];
  }
  const parts = message.parts ?? [];
  if (parts.length === 0) {
    const items: SessionItemDraft[] = [];
    if (message.text.length > 0) {
      items.push({
        ...base,
        itemId: `${message.id}:text`,
        status: messageStatusOf(message.status),
        createdAt,
        payload: { kind: "text", text: message.text },
      });
    }
    if ((message.reasoning ?? "").length > 0) {
      items.push({
        ...base,
        itemId: `${message.id}:reasoning`,
        status: messageStatusOf(message.status),
        createdAt,
        payload: { kind: "reasoning", text: message.reasoning ?? "" },
      });
    }
    return items;
  }
  const partIds = new Map<string, number>();
  return parts.flatMap((part) => expandPart(base, message.id, part, createdAt, partIds));
}

function expandPart(
  base: ItemBase,
  messageId: string,
  part: ConversationMessagePart,
  createdAt: string,
  partIds: Map<string, number>,
): SessionItemDraft[] {
  switch (part.kind) {
    case "text":
      return [
        {
          ...base,
          itemId: scopedPartId(messageId, part.id, partIds),
          status: partStatusOf(part.state),
          createdAt,
          payload: { kind: "text", text: part.text },
        },
      ];
    case "reasoning":
      return [
        {
          ...base,
          itemId: scopedPartId(messageId, part.id, partIds),
          status: partStatusOf(part.state),
          createdAt,
          payload: { kind: "reasoning", text: part.text },
        },
      ];
    case "tool": {
      const items: SessionItemDraft[] = [
        {
          ...base,
          itemId: part.id,
          status: "complete",
          createdAt,
          payload: {
            kind: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            ...(part.title === undefined ? {} : { title: part.title }),
            ...(part.input === undefined ? {} : { input: part.input }),
            ...(part.inputText === undefined ? {} : { inputText: part.inputText }),
          },
        },
      ];
      const outcome = toolOutcomeOf(part.state);
      if (outcome === undefined) return items;
      items.push({
        ...base,
        itemId: `${part.toolCallId}:result`,
        status: "complete",
        createdAt,
        payload: {
          kind: "tool-result",
          toolCallId: part.toolCallId,
          outcome,
          ...(outcome === "output" ? { output: part.output } : {}),
          ...(outcome === "error" && part.errorText !== undefined
            ? { errorText: part.errorText }
            : {}),
        },
      });
      return items;
    }
    default:
      return [];
  }
}

function turnEndItem(
  turnId: string,
  messages: ReadonlyArray<{ message: ConversationMessage; items: SessionItemDraft[] }>,
  createdAt: string,
): SessionItemDraft {
  const last = [...messages].reverse().find((entry) => entry.message.role === "assistant");
  const status: SessionItemStatus =
    last === undefined
      ? "interrupted"
      : last.message.status === "complete"
        ? "complete"
        : last.message.status === "failed"
          ? "failed"
          : "interrupted";
  const toolCalls = messages.reduce(
    (count, entry) =>
      count + entry.items.filter((item) => item.payload.kind === "tool-call").length,
    0,
  );
  return {
    itemId: `${turnId}:end`,
    status,
    createdAt,
    turnId,
    payload: {
      kind: "turn-end",
      stepCount: 0,
      toolCalls,
      ...(status === "interrupted"
        ? {
            interruption: {
              reason: last?.message.status === "streaming" ? "process-exit" : "migrated",
              at: createdAt,
            },
          }
        : {}),
    },
  };
}

function messageStatusOf(status: ConversationMessage["status"]): SessionItemStatus {
  if (status === "complete") return "complete";
  if (status === "failed") return "failed";
  return "interrupted";
}

/** 旧 part id 只在消息内唯一（provider 固定发 `txt-0`），条目 id 需要会话内唯一。 */
function scopedPartId(messageId: string, partId: string, used: Map<string, number>): string {
  const next = (used.get(partId) ?? 0) + 1;
  used.set(partId, next);
  return `${messageId}:${partId}:${next}`;
}

function partStatusOf(
  state: Extract<ConversationMessagePart, { kind: "text" }>["state"],
): SessionItemStatus {
  if (state === "completed") return "complete";
  if (state === "failed") return "failed";
  return "interrupted";
}

function toolOutcomeOf(
  state: Extract<ConversationMessagePart, { kind: "tool" }>["state"],
): "output" | "error" | "denied" | undefined {
  if (state === "completed") return "output";
  if (state === "failed") return "error";
  if (state === "denied") return "denied";
  return undefined;
}

/**
 * 条目帧 → 会话视图的增量折叠：按 `item_id` upsert，绝不盲追加。
 *
 * 规则与 `@answra/shared` 的 `foldSessionItems` 对齐，但输入是「快照 + 逐条到达的条目」：
 * 快照已含历史消息，这里只把新条目并进去。同一 part 可能先以内存半截出现在快照里，
 * 随后以完整条目到达，所以按 id 替换而不是追加。
 */
import type {
  ConversationMessagePart,
  SessionFrame,
  SessionItem,
  SessionItemStatus,
} from "@answra/shared/schema";
import type { ConversationViewMessage } from "../components/chat/conversationMessage";
import type { ConversationView } from "./conversationView";

export function foldSessionItemFrame(
  view: ConversationView,
  frame: SessionFrame,
  item: SessionItem,
): ConversationView {
  const next: ConversationView = { ...view, lastSeq: frame.seq };
  switch (item.payload.kind) {
    case "user":
      return appendUser(next, item);
    case "text":
    case "reasoning":
      return upsertSettledPart(next, item);
    case "tool-call":
      return upsertToolCall(next, item);
    case "tool-result":
      return upsertToolResult(next, item);
    case "turn-end":
      return settleTurn(next, item);
  }
}

function appendUser(view: ConversationView, item: SessionItem): ConversationView {
  if (item.payload.kind !== "user") return view;
  if (view.messages.some((message) => message.id === item.itemId)) return view;
  const message: ConversationViewMessage = {
    id: item.itemId,
    role: "user",
    text: item.payload.text,
    images: [...item.payload.images],
    status: "complete",
    parts: [],
  };
  // 新的用户输入代表上一轮失败提示已经过期；错误由这一轮的 turn-end 重新给出。
  return { ...view, error: undefined, messages: [...view.messages, message] };
}

function upsertSettledPart(view: ConversationView, item: SessionItem): ConversationView {
  const payload = item.payload;
  if (payload.kind !== "text" && payload.kind !== "reasoning") return view;
  const messageId = item.messageId;
  if (messageId === undefined) return view;
  const part: ConversationMessagePart = {
    id: item.itemId,
    kind: payload.kind,
    text: payload.text,
    state: partStateOf(item.status),
  };
  return updateMessage(view, item, (message) => {
    const parts = upsertPart(message.parts ?? [], part);
    const reasoning = joinParts(parts, "reasoning");
    return {
      ...message,
      parts,
      text: joinParts(parts, "text"),
      ...(reasoning === "" ? { reasoning: undefined } : { reasoning }),
      waitingForStream: false,
    };
  });
}

function upsertToolCall(view: ConversationView, item: SessionItem): ConversationView {
  const payload = item.payload;
  if (payload.kind !== "tool-call") return view;
  const part: ConversationMessagePart = {
    id: item.itemId,
    kind: "tool",
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    ...(payload.title === undefined ? {} : { title: payload.title }),
    ...(payload.inputText === undefined ? {} : { inputText: payload.inputText }),
    ...(payload.input === undefined ? {} : { input: payload.input }),
    state: item.turnId !== undefined && item.turnId === view.activeTurnId ? "running" : "pending",
  };
  return updateMessage(view, item, (message) => ({
    ...message,
    parts: upsertPart(message.parts ?? [], part),
    waitingForStream: false,
  }));
}

function upsertToolResult(view: ConversationView, item: SessionItem): ConversationView {
  const payload = item.payload;
  if (payload.kind !== "tool-result") return view;
  return updateMessage(view, item, (message) => {
    const parts = message.parts ?? [];
    const index = parts.findIndex(
      (part) => part.kind === "tool" && part.toolCallId === payload.toolCallId,
    );
    const part = index < 0 ? undefined : parts[index];
    // 缺少 tool-call 说明客户端丢了帧；整段重读会补齐，这里不猜测凭空建 part。
    if (index < 0 || part?.kind !== "tool") return message;
    const settled: ConversationMessagePart = {
      ...part,
      state: toolStateOf(payload.outcome),
      ...(payload.outcome === "output" ? { output: payload.output } : {}),
      ...(payload.outcome === "error" ? { errorText: payload.errorText } : {}),
    };
    return { ...message, parts: replaceAt(parts, index, settled) };
  });
}

function settleTurn(view: ConversationView, item: SessionItem): ConversationView {
  const turnId = item.turnId;
  if (turnId === undefined) return view;
  const target = lastMessageOfTurn(view.messages, turnId) ?? activeMessage(view);
  if (target === undefined) {
    return {
      ...view,
      activeTurnId: view.activeTurnId === turnId ? undefined : view.activeTurnId,
      // 即使找不到消息，Turn 归因也必须以本条收口为准，否则上一轮错误会一直留着。
      error: item.payload.kind === "turn-end" ? item.payload.errorText : view.error,
    };
  }
  const messages = view.messages.map((message) =>
    message.id === target.id
      ? {
          ...message,
          status: item.status,
          thinking: false,
          waitingForStream: false,
          parts: settleUnresolvedParts(message.parts, item.status),
        }
      : message,
  );
  const retryBelongs = view.retryMessageId === target.id;
  return {
    ...view,
    messages,
    activeTurnId: view.activeTurnId === turnId ? undefined : view.activeTurnId,
    activeMessageId: view.activeMessageId === target.id ? undefined : view.activeMessageId,
    // Turn 归因文本是失败原因的 durable 来源；成功或中断不再保留旧错误。
    error: item.payload.kind === "turn-end" ? item.payload.errorText : undefined,
    retry:
      retryBelongs && item.status === "failed" && view.retry !== undefined
        ? { ...view.retry, finished: true }
        : retryBelongs
          ? undefined
          : view.retry,
    retryMessageId: retryBelongs && item.status !== "failed" ? undefined : view.retryMessageId,
  };
}

function updateMessage(
  view: ConversationView,
  item: SessionItem,
  update: (message: ConversationViewMessage) => ConversationViewMessage,
): ConversationView {
  const messageId = item.messageId;
  if (messageId === undefined) return view;
  const index = view.messages.findIndex((message) => message.id === messageId);
  const existing = index < 0 ? undefined : view.messages[index];
  const base: ConversationViewMessage = existing ?? {
    id: messageId,
    role: "assistant",
    text: "",
    status: "streaming",
    parts: [],
    ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
  };
  const updated = update(base);
  const messages =
    index < 0
      ? [...view.messages, updated]
      : [...view.messages.slice(0, index), updated, ...view.messages.slice(index + 1)];
  return { ...view, messages };
}

function activeMessage(view: ConversationView): ConversationViewMessage | undefined {
  if (view.activeMessageId === undefined) return undefined;
  return view.messages.find((message) => message.id === view.activeMessageId);
}

function lastMessageOfTurn(
  messages: readonly ConversationViewMessage[],
  turnId: string,
): ConversationViewMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.turnId === turnId) return message;
  }
  return undefined;
}

function settleUnresolvedParts(
  parts: readonly ConversationMessagePart[] | undefined,
  status: SessionItemStatus,
): ConversationMessagePart[] | undefined {
  if (parts === undefined) return undefined;
  return parts.map((part) => {
    if (part.kind !== "tool") return part;
    if (part.state !== "pending" && part.state !== "running") return part;
    return { ...part, state: status === "failed" ? "failed" : "interrupted" };
  });
}

function upsertPart(
  parts: readonly ConversationMessagePart[],
  part: ConversationMessagePart,
): ConversationMessagePart[] {
  const index = parts.findIndex((existing) => existing.id === part.id);
  return index < 0 ? [...parts, part] : replaceAt(parts, index, part);
}

function replaceAt(
  parts: readonly ConversationMessagePart[],
  index: number,
  part: ConversationMessagePart,
): ConversationMessagePart[] {
  return [...parts.slice(0, index), part, ...parts.slice(index + 1)];
}

function joinParts(parts: readonly ConversationMessagePart[], kind: "text" | "reasoning"): string {
  let text = "";
  for (const part of parts) if (part.kind === kind) text += part.text;
  return text;
}

function partStateOf(status: SessionItemStatus): "completed" | "failed" | "interrupted" {
  return status === "complete" ? "completed" : status;
}

function toolStateOf(outcome: "output" | "error" | "denied"): "completed" | "failed" | "denied" {
  if (outcome === "output") return "completed";
  return outcome === "error" ? "failed" : "denied";
}

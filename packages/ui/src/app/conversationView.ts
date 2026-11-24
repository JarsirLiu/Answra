/**
 * 唯一的会话视图折叠：snapshot 初始化，`SessionFrame` 折叠已结算条目，
 * `LiveFrame` 叠加可丢的增量与运行提示。
 */
import type {
  ContextCompactionBoundary,
  ContextCompactionStatus,
  ContextPruningStatus,
  ContextUsage,
  ConversationMessage,
  ConversationMessagePart,
  ConversationSnapshot,
  LiveFrame,
  ReplyBarActivity,
  SessionFrame,
} from "@answra/shared";
import type {
  ConversationRetry,
  ConversationViewMessage,
} from "../components/chat/conversationMessage";
import { foldSessionItemFrame } from "./conversationItems";
import {
  applyConversationPartEvent,
  reasoningFromConversationParts,
  textFromConversationParts,
} from "./conversationParts";
import { projectReplyActivity } from "./replyActivity";

export type {
  ConversationRetry,
  ConversationViewMessage,
} from "../components/chat/conversationMessage";
export { contextCompactionLabel } from "./contextCompaction";
export {
  contextPruningLabel,
  contextUsagePercent,
  formatContextTokens,
  isReportedContextUsage,
} from "./contextUsage";

export interface ConversationView {
  /** durable frame 游标：缺口由整段重读补齐，不靠逐帧补洞。 */
  lastSeq: number;
  messages: ConversationViewMessage[];
  /** 当前活动 Turn；取消按它定位。 */
  activeTurnId?: string;
  /** 当前活动 assistant 消息；渲染与滚动按它定位。 */
  activeMessageId?: string;
  retry?: ConversationRetry;
  retryMessageId?: string;
  error?: string;
  contextCompaction?: ContextCompactionStatus;
  contextCompactionBoundaries?: readonly ContextCompactionBoundary[];
  contextUsage?: ContextUsage;
  contextPruning?: ContextPruningStatus;
}

export const EMPTY_CONVERSATION_VIEW: ConversationView = {
  lastSeq: 0,
  messages: [],
};

export interface ConversationProjectionOptions {
  retainCapturedRound?: boolean;
  trackActivities?: boolean;
}

/** durable frame 的会话身份。 */
export function conversationOfFrame(frame: SessionFrame): string {
  return frame.sessionId;
}

/** durable frame 的游标；与旧 envelope 的 revision 不是同一个量。 */
export function sequenceOf(frame: SessionFrame): number {
  return frame.seq;
}

export function applyConversationSnapshot(
  view: ConversationView,
  snapshot: ConversationSnapshot,
  options: ConversationProjectionOptions = {},
): ConversationView {
  if (options.retainCapturedRound && snapshot.messages.length === 0 && view.messages.length > 0)
    return {
      ...view,
      lastSeq: snapshot.lastSeq,
      activeTurnId: undefined,
      activeMessageId: undefined,
      contextCompaction: snapshot.contextCompaction,
      contextCompactionBoundaries: snapshot.contextCompactionBoundaries,
      contextUsage: snapshot.contextUsage,
      contextPruning: snapshot.contextPruning,
    };
  const prior = new Map(view.messages.map((message) => [message.id, message]));
  const keepRetry =
    snapshot.activeMessageId !== undefined && snapshot.activeMessageId === view.retryMessageId
      ? view.retry
      : undefined;
  return {
    lastSeq: snapshot.lastSeq,
    messages: snapshot.messages.map((message) =>
      toViewMessage(message, prior.get(message.id), snapshot.activeMessageId === message.id),
    ),
    activeTurnId: snapshot.activeTurnId,
    activeMessageId: snapshot.activeMessageId,
    retry: keepRetry,
    retryMessageId: keepRetry === undefined ? undefined : view.retryMessageId,
    contextCompaction: snapshot.contextCompaction,
    contextCompactionBoundaries: snapshot.contextCompactionBoundaries,
    contextUsage: selectSnapshotContextUsage(view.contextUsage, snapshot.contextUsage),
    contextPruning: snapshot.contextPruning,
    // 失败原因来自 turn-end 条目，snapshot 不重复承载；保留到下一次用户消息再清除，
    // 否则收口后的 snapshot 会把用户刚看到的错误立刻擦掉。空快照表示会话已清空。
    error: snapshot.messages.length === 0 ? undefined : view.error,
  };
}

/**
 * 折叠一条 durable 事实帧。
 *
 * durable 通道只装已结算条目，因此这里没有第二种事件分支。
 * 按 `seq` 幂等：小于等于游标的帧直接丢弃，重复投递不会改变结果。
 * durable 缺口不在这里补；调用方发现 `frame.seq > view.lastSeq + 1` 时整段重读。
 */
export function foldConversationFrame(
  view: ConversationView,
  frame: SessionFrame,
): ConversationView {
  if (frame.seq <= view.lastSeq) return view;
  return foldSessionItemFrame(view, frame, frame.event.item);
}

/**
 * 叠加一条 live 帧。
 *
 * 允许丢失、允许乱序：只影响瞬时观感，条目或快照到达后会被覆盖。
 * `retry` / `error` 是可丢的运行提示，正文增量只改变当前消息的 parts。
 */
export function overlayLiveFrame(
  view: ConversationView,
  frame: LiveFrame,
  options: ConversationProjectionOptions = {},
): ConversationView {
  const event = frame.event;
  if (event.type === "retry") {
    return { ...view, retry: event, retryMessageId: frame.messageId };
  }
  if (event.type === "error") {
    const next = updateMessage(view, frame.messageId, (item) => ({
      ...item,
      thinking: false,
      waitingForStream: false,
    }));
    return { ...next, error: event.errorText };
  }
  const message = view.messages.find((item) => item.id === frame.messageId);
  if (!message) return view;
  const parts = applyConversationPartEvent(message.parts ?? [], event);
  if (!parts) return view;
  const reasoning = reasoningFromConversationParts(parts);
  const next = {
    ...updateMessage(view, frame.messageId, (item) => ({
      ...item,
      parts,
      text: textFromConversationParts(parts),
      thinking: event.type === "reasoning-delta",
      waitingForStream: false,
      ...(reasoning ? { reasoning } : {}),
    })),
    // 模型重新产出增量即代表上一轮的错误提示已过期。
    error: undefined,
  };
  if (!options.trackActivities) return next;
  const activities = projectReplyActivity([...(message.activities ?? [])], {
    messageId: frame.messageId,
    event,
  });
  return updateMessage(next, frame.messageId, (item) => ({ ...item, activities }));
}

function updateMessage(
  view: ConversationView,
  id: string,
  update: (message: ConversationViewMessage) => ConversationViewMessage,
): ConversationView {
  return {
    ...view,
    messages: view.messages.map((message) => (message.id === id ? update(message) : message)),
  };
}

function toViewMessage(
  message: ConversationMessage,
  prior?: ConversationViewMessage,
  activeMessage = false,
): ConversationViewMessage {
  const parts = messageParts(message);
  const text = textFromConversationParts(parts) || message.text;
  const reasoning = reasoningFromConversationParts(parts) || message.reasoning || prior?.reasoning;
  const activities = prior?.activities ?? activitiesFromParts(parts);
  return {
    id: message.id,
    role: message.role,
    text,
    status: message.status,
    images: message.images,
    parts,
    ...(prior?.thinking === undefined ? {} : { thinking: prior.thinking }),
    waitingForStream: prior?.thinking ? false : (prior?.waitingForStream ?? activeMessage),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(activities.length === 0 ? {} : { activities }),
  };
}

function messageParts(message: ConversationMessage): ConversationMessagePart[] {
  if (message.parts && message.parts.length > 0) return message.parts;
  const parts: ConversationMessagePart[] = [];
  if (message.reasoning)
    parts.push({
      id: `${message.id}:reasoning`,
      kind: "reasoning",
      text: message.reasoning,
      state: "completed",
    });
  if (message.text)
    parts.push({
      id: `${message.id}:text`,
      kind: "text",
      text: message.text,
      state: "completed",
    });
  return parts;
}

function activitiesFromParts(parts: ConversationMessagePart[]): ReplyBarActivity[] {
  return parts.flatMap((part) => {
    if (part.kind !== "tool") return [];
    const activities: ReplyBarActivity[] = [
      {
        id: `${part.toolCallId}:input-ready`,
        kind: "tool",
        label: `工具：${part.title ?? part.toolName}`,
        text: formatToolValue(part.input ?? part.inputText ?? ""),
      },
    ];
    if (part.output !== undefined)
      activities.push({
        id: `${part.toolCallId}:output`,
        kind: "tool",
        label: "工具结果",
        text: formatToolValue(part.output),
      });
    if (part.errorText)
      activities.push({
        id: `${part.toolCallId}:error`,
        kind: "error",
        label: "工具失败",
        text: part.errorText,
      });
    return activities;
  });
}

function formatToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "工具已返回结果";
  }
}

/**
 * snapshot 更新 usage 的规则：provider 总是覆盖；压缩后的估算只在时间更新时覆盖旧 provider。
 * 普通发送前的估算沿用旧值，不允许把 provider 实测回退成准备阶段估算。
 */
function selectSnapshotContextUsage(
  current: ContextUsage | undefined,
  incoming: ContextUsage | undefined,
): ContextUsage | undefined {
  if (incoming === undefined) return current?.source === "provider" ? current : incoming;
  if (current === undefined) return incoming;
  if (incoming.source === "provider") return incoming;
  if (current.source !== "provider") return incoming;
  if (incoming.source !== "compaction") return current;
  return isNewerContextUsage(incoming, current) ? incoming : current;
}

function isNewerContextUsage(next: ContextUsage, current: ContextUsage): boolean {
  const nextTime = Date.parse(next.updatedAt);
  const currentTime = Date.parse(current.updatedAt);
  return Number.isFinite(nextTime) && Number.isFinite(currentTime) && nextTime > currentTime;
}

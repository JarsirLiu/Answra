/**
 * 唯一的会话视图折叠：snapshot 初始化，`SessionFrame` 折叠 durable 事实，
 * `LiveFrame` 叠加可丢的增量。
 *
 * 会话路径只吃 frame；`applyAgentEvent` 仅服务 P3 前仍走 envelope 的 Answer。
 */
import type {
  AgentEventEnvelope,
  AgentStreamEvent,
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
import {
  applyConversationPartEvent,
  reasoningFromConversationParts,
  settleConversationParts,
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
  /** Answer shim 的 envelope 游标；会话路径不再推进它。 */
  eventRevision: number;
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
  eventRevision: 0,
  lastSeq: 0,
  messages: [],
};

export interface ConversationProjectionOptions {
  retainCapturedRound?: boolean;
  trackActivities?: boolean;
}

/** 旧 envelope 的 revision；只服务 Answer shim。 */
export function eventRevision(event: AgentEventEnvelope): number {
  return event.aggregateRevision;
}

export function conversationOf(event: AgentEventEnvelope): string {
  return event.conversationId ?? "";
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
      eventRevision: snapshot.eventRevision,
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
    eventRevision: snapshot.eventRevision,
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
    // A snapshot is the server's current conversation truth. Do not carry a
    // terminal error from the previous run into a cleared or resumed view.
    error: undefined,
  };
}

/**
 * 折叠一条 durable 事实帧。
 *
 * 按 `seq` 幂等：小于等于游标的帧直接丢弃，重复投递不会改变结果。
 * durable 缺口不在这里补；调用方发现 `frame.seq > view.lastSeq + 1` 时整段重读。
 */
export function foldConversationFrame(
  view: ConversationView,
  frame: SessionFrame,
  options: ConversationProjectionOptions = {},
): ConversationView {
  if (frame.seq <= view.lastSeq) return view;
  const event = frame.event;
  let next: ConversationView = { ...view, lastSeq: frame.seq };
  const messageId = frame.messageId;

  switch (event.type) {
    case "turn-queued":
      // 排队只表达"已接纳"，不产生活动消息。
      return next;
    case "turn-started":
      return {
        ...next,
        ...(frame.turnId === undefined ? {} : { activeTurnId: frame.turnId }),
        ...(messageId === undefined ? {} : { activeMessageId: messageId }),
        error: undefined,
      };
    case "turn-handoff": {
      // handoff 的 messageId 是**来源**消息；接收方消息由下一次 snapshot 认领。
      const settled =
        messageId === undefined ? next : settleMessage(next, messageId, "complete", false);
      return {
        ...settled,
        activeMessageId: undefined,
        retry: undefined,
        retryMessageId: undefined,
      };
    }
    case "turn-finished": {
      const target = messageId ?? next.activeMessageId;
      const status = messageStatusForTurnStatus(event.status);
      if (target !== undefined)
        next = settleMessage(next, target, status, event.status === "failed");
      const retryBelongs = target !== undefined && next.retryMessageId === target;
      const retry = retryBelongs ? next.retry : undefined;
      return {
        ...next,
        activeTurnId: next.activeTurnId === frame.turnId ? undefined : next.activeTurnId,
        activeMessageId: next.activeMessageId === target ? undefined : next.activeMessageId,
        retry: retryBelongs
          ? event.status === "failed" && retry !== undefined
            ? { ...retry, finished: true }
            : undefined
          : next.retry,
        retryMessageId: retryBelongs && event.status !== "failed" ? undefined : next.retryMessageId,
      };
    }
    case "context-usage-changed": {
      if (next.contextUsage === undefined) return next;
      return {
        ...next,
        contextUsage: {
          ...next.contextUsage,
          usedTokens: event.usedTokens,
          source: "provider",
          updatedAt: frame.occurredAt,
        },
      };
    }
    default:
      break;
  }

  if (messageId === undefined) {
    return event.type === "error" ? { ...next, error: event.errorText } : next;
  }
  if (!next.messages.some((message) => message.id === messageId)) {
    return event.type === "error" ? { ...next, error: event.errorText } : next;
  }
  if (
    event.type === "step-started" ||
    event.type === "step-finished" ||
    event.type === "part-state-changed" ||
    event.type === "compaction-started" ||
    event.type === "compaction-finished" ||
    event.type === "compaction-failed" ||
    event.type === "compaction-aborted"
  )
    return next;
  if (event.type !== "start") {
    next = updateMessage(next, messageId, (message) => ({
      ...message,
      waitingForStream: false,
    }));
    // 交接后的第一条事实就是新消息的归属：不必等 snapshot 才认领。
    if (next.activeMessageId === undefined) next = { ...next, activeMessageId: messageId };
  }
  return applyStreamEvent(next, messageId, event, options);
}

/**
 * 叠加一条 live 增量帧。
 *
 * 允许丢失、允许乱序：只影响瞬时观感，durable 完整值到达后会被覆盖。
 */
export function overlayLiveFrame(
  view: ConversationView,
  frame: LiveFrame,
  options: ConversationProjectionOptions = {},
): ConversationView {
  const message = view.messages.find((item) => item.id === frame.messageId);
  if (!message) return view;
  const parts = applyConversationPartEvent(message.parts ?? [], frame.event);
  if (!parts) return view;
  const reasoning = reasoningFromConversationParts(parts);
  const next = updateMessage(view, frame.messageId, (item) => ({
    ...item,
    parts,
    text: textFromConversationParts(parts),
    thinking: frame.event.type === "reasoning-delta",
    waitingForStream: false,
    ...(reasoning ? { reasoning } : {}),
  }));
  if (!options.trackActivities) return next;
  const activities = projectReplyActivity([...(message.activities ?? [])], {
    messageId: frame.messageId,
    event: frame.event,
  });
  return updateMessage(next, frame.messageId, (item) => ({ ...item, activities }));
}

/** P3 前 Answer 仍按旧 envelope 折叠；会话路径不得再调用它。 */
export function applyAgentEvent(
  view: ConversationView,
  envelope: AgentEventEnvelope,
  options: ConversationProjectionOptions = {},
): ConversationView {
  if (envelope.aggregateRevision <= view.eventRevision) return view;
  const event = envelope.event;
  let next = { ...view, eventRevision: envelope.aggregateRevision };
  if (event.type === "run-state-changed") {
    const messageStatus = conversationStatusForRunState(event.state);
    if (!messageStatus) {
      next = { ...next, activeMessageId: envelope.runId };
      next = updateMessage(next, envelope.runId, (message) => ({
        ...message,
        waitingForStream: event.state === "claimed" || event.state === "running",
      }));
      if (event.state === "retry-wait" && event.retry)
        next = { ...next, retry: event.retry, retryMessageId: envelope.runId };
      if (event.state === "running" && next.retryMessageId === envelope.runId)
        next = { ...next, retry: undefined, retryMessageId: undefined };
    } else {
      const retryBelongsToMessage =
        next.retryMessageId === envelope.runId && next.retry !== undefined;
      const failed = messageStatus === "failed";
      const retry = next.retry;
      next = {
        ...next,
        activeMessageId: next.activeMessageId === envelope.runId ? undefined : next.activeMessageId,
        retry: retryBelongsToMessage
          ? failed && retry
            ? { ...retry, finished: true }
            : undefined
          : retry,
        retryMessageId: retryBelongsToMessage && !failed ? undefined : next.retryMessageId,
        messages: next.messages.map((message) =>
          message.id === envelope.runId
            ? {
                ...message,
                thinking: false,
                waitingForStream: false,
                status: messageStatus,
                parts: message.parts
                  ? settleConversationParts(message.parts, failed ? "failed" : "interrupted")
                  : message.parts,
              }
            : message,
        ),
      };
    }
    return next;
  }
  if (event.type === "context-usage-changed") {
    if (next.contextUsage === undefined) return next;
    return {
      ...next,
      contextUsage: {
        ...next.contextUsage,
        usedTokens: event.usedTokens,
        source: "provider",
        updatedAt: envelope.occurredAt,
      },
    };
  }
  const hasMessage = next.messages.some((message) => message.id === envelope.runId);
  if (!hasMessage) return event.type === "error" ? { ...next, error: event.errorText } : next;
  if (
    event.type === "turn-queued" ||
    event.type === "turn-started" ||
    event.type === "turn-finished" ||
    event.type === "turn-handoff" ||
    event.type === "compaction-started" ||
    event.type === "compaction-finished" ||
    event.type === "compaction-failed" ||
    event.type === "compaction-aborted"
  )
    return next;
  if (
    event.type === "step-started" ||
    event.type === "step-finished" ||
    event.type === "part-state-changed"
  )
    return next;
  if (event.type !== "start") {
    next = updateMessage(next, envelope.runId, (message) => ({
      ...message,
      waitingForStream: false,
    }));
  }
  return applyStreamEvent(next, envelope.runId, event, options);
}

function messageStatusForTurnStatus(
  status: Extract<SessionFrame["event"], { type: "turn-finished" }>["status"],
): ConversationMessage["status"] {
  switch (status) {
    case "completed":
      return "complete";
    case "failed":
      return "failed";
    case "aborted":
      return "interrupted";
  }
}

function conversationStatusForRunState(
  state: Extract<AgentEventEnvelope["event"], { type: "run-state-changed" }>["state"],
): ConversationMessage["status"] | undefined {
  switch (state) {
    case "completed":
      return "complete";
    case "failed":
    case "orphaned":
      return "failed";
    case "aborted":
    case "superseded":
      return "interrupted";
    case "queued":
    case "claimed":
    case "running":
    case "retry-wait":
      return undefined;
  }
}

function settleMessage(
  view: ConversationView,
  messageId: string,
  status: ConversationMessage["status"],
  failed: boolean,
): ConversationView {
  return updateMessage(view, messageId, (message) => ({
    ...message,
    thinking: false,
    waitingForStream: false,
    status,
    parts: message.parts
      ? settleConversationParts(message.parts, failed ? "failed" : "interrupted")
      : message.parts,
  }));
}

function applyStreamEvent(
  view: ConversationView,
  messageId: string,
  event: AgentStreamEvent,
  options: ConversationProjectionOptions,
): ConversationView {
  let next = view;
  switch (event.type) {
    case "retry":
      next = { ...next, retry: event, retryMessageId: messageId };
      break;
    case "start":
      next = {
        ...setThinking(next, messageId, false),
        retry: undefined,
        retryMessageId: undefined,
        error: undefined,
      };
      break;
    case "error":
      next = { ...setThinking(next, messageId, false), error: event.errorText };
      break;
    default:
      next = updateMessage(next, messageId, (message) => {
        const parts = applyConversationPartEvent(message.parts ?? [], event);
        if (!parts) return { ...message, thinking: false };
        const reasoning = reasoningFromConversationParts(parts);
        return {
          ...message,
          parts,
          text: textFromConversationParts(parts),
          thinking: event.type === "reasoning-start" || event.type === "reasoning-delta",
          ...(reasoning ? { reasoning } : {}),
        };
      });
  }
  if (options.trackActivities) {
    const message = next.messages.find((item) => item.id === messageId);
    const activities = projectReplyActivity([...(message?.activities ?? [])], {
      messageId,
      event,
    });
    next = updateMessage(next, messageId, (item) => ({ ...item, activities }));
  }
  return next;
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

function setThinking(view: ConversationView, id: string, thinking: boolean): ConversationView {
  return updateMessage(view, id, (message) => ({ ...message, thinking }));
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

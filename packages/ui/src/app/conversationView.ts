import type { ConversationChange, ConversationMessage } from "@answra/shared";
import type {
  ConversationRetry,
  ConversationViewMessage,
} from "../components/chat/conversationMessage";
import { projectReplyActivity } from "./replyActivity";

/** 一份投影状态：所有前端会话表面（对话/面试/回复详情）共用。 */
export interface ConversationView {
  revision: number;
  messages: ConversationViewMessage[];
  activeRunId?: string;
  retry?: ConversationRetry;
  /** 重试事件所属的 run，用于快照切换时保留可回放的 Wi‑Fi 状态。 */
  retryRunId?: string;
  error?: string;
}

export const EMPTY_CONVERSATION_VIEW: ConversationView = {
  revision: -1,
  messages: [],
};

export interface ConversationProjectionOptions {
  /** 答题会话结束后 agent 会发布空快照；详情面板仍要保留本轮内容。 */
  retainCapturedRound?: boolean;
  /** 回复详情需要工具/来源/错误等活动卡片；对话与面试不需要。 */
  trackActivities?: boolean;
}

export function conversationChangeRevision(change: ConversationChange): number {
  if (change.type === "event") return change.event.revision;
  return change.type === "snapshot" ? change.snapshot.revision : change.revision;
}

export function conversationOf(change: ConversationChange): string {
  if (change.type === "event") return change.event.conversationId;
  if (change.type === "snapshot") return change.snapshot.conversationId;
  return change.conversationId;
}

export function applyConversationChange(
  view: ConversationView,
  change: ConversationChange,
  conversationId: string,
  options: ConversationProjectionOptions = {},
): ConversationView {
  if (conversationOf(change) !== conversationId) return view;
  const revision = conversationChangeRevision(change);
  if (revision <= view.revision) return view;

  switch (change.type) {
    case "snapshot": {
      const snapshot = change.snapshot;
      if (
        options.retainCapturedRound &&
        snapshot.messages.length === 0 &&
        !snapshot.activeRunId &&
        view.messages.length > 0
      ) {
        return clearRetry({ ...view, revision, activeRunId: undefined });
      }
      const prior = new Map(view.messages.map((message) => [message.id, message]));
      const keepRetry = Boolean(
        view.retry &&
          view.retryRunId &&
          (snapshot.activeRunId === view.retryRunId ||
            snapshot.messages.some((message) => message.id === view.retryRunId)),
      );
      return {
        revision,
        messages: snapshot.messages.map((message) => toViewMessage(message, prior.get(message.id))),
        activeRunId: snapshot.activeRunId,
        ...(keepRetry && view.retry ? { retry: view.retry, retryRunId: view.retryRunId } : {}),
        error: view.error,
      };
    }
    case "messages-appended": {
      // 新的 assistant 回合开始即清掉上一轮错误；用户消息追加不承担清错职责。
      const startsReply = change.messages.some((message) => message.role === "assistant");
      return {
        ...view,
        revision,
        messages: [...view.messages, ...change.messages.map((message) => toViewMessage(message))],
        activeRunId: change.activeRunId,
        error: startsReply ? undefined : view.error,
        ...clearRetryFields(),
      };
    }
    case "event": {
      const { event } = change;
      return applyStreamEvent({ ...view, revision }, event, options);
    }
    case "run-finished": {
      const existing = view.messages.find((message) => message.id === change.runId);
      const finished = { ...toViewMessage(change.message, existing), thinking: false };
      const keepRetry =
        change.outcome === "failed" &&
        Boolean(view.retry) &&
        (!view.retryRunId || view.retryRunId === change.runId);
      const retry = keepRetry && view.retry ? { ...view.retry, finished: true } : undefined;
      return {
        ...view,
        revision,
        activeRunId: view.activeRunId === change.runId ? undefined : view.activeRunId,
        ...(retry ? { retry, retryRunId: view.retryRunId } : clearRetryFields()),
        messages: existing
          ? view.messages.map((message) => (message.id === change.runId ? finished : message))
          : [...view.messages, finished],
      };
    }
  }
}

/**
 * 初始化时补放快照已覆盖的历史事件：正文已在快照里，只回放思维链与活动卡片。
 */
export function applyHistoricalConversationEvent(
  view: ConversationView,
  change: ConversationChange,
  conversationId: string,
  options: ConversationProjectionOptions = {},
): ConversationView {
  if (change.type !== "event" || conversationOf(change) !== conversationId) return view;
  return applyStreamEvent(view, change.event, options);
}

function applyStreamEvent(
  view: ConversationView,
  event: Extract<ConversationChange, { type: "event" }>["event"],
  options: ConversationProjectionOptions,
): ConversationView {
  const hasMessage = view.messages.some((message) => message.id === event.runId);
  if (!hasMessage) {
    return event.stream.type === "error" ? { ...view, error: event.stream.errorText } : view;
  }

  let next = view;
  switch (event.stream.type) {
    case "retry":
      next = {
        ...setMessageThinking(next, event.runId, false),
        retry: {
          kind: event.stream.kind,
          attempt: event.stream.attempt,
          maxRetries: event.stream.maxRetries,
        },
        retryRunId: event.runId,
      };
      break;
    case "reasoning-start":
      next = setMessageThinking(next, event.runId, true);
      break;
    case "start":
      next = setMessageThinking(next, event.runId, false);
      break;
    case "reasoning-delta": {
      const delta = event.stream.delta;
      next = updateMessage(next, event.runId, (message) => ({
        ...message,
        thinking: true,
        reasoning: (message.reasoning ?? "") + delta,
      }));
      break;
    }
    case "reasoning-end":
    case "text-start":
    case "text-end":
    case "tool-input-start":
    case "tool-input-delta":
    case "tool-call":
    case "tool-result":
    case "tool-error":
    case "source-url":
    case "source-document":
    case "error":
      next = setMessageThinking(next, event.runId, false);
      break;
    case "text-delta": {
      const delta = event.stream.delta;
      next = updateMessage(next, event.runId, (message) => ({
        ...message,
        ...(message.thinking === undefined ? {} : { thinking: false }),
        text: message.text + delta,
      }));
      break;
    }
  }

  if (event.stream.type === "start") next = clearRetry(next);
  if (event.stream.type === "error") next = { ...next, error: event.stream.errorText };
  if (options.trackActivities) next = withActivities(next, event);
  return next;
}

function updateMessage(
  view: ConversationView,
  messageId: string,
  update: (message: ConversationViewMessage) => ConversationViewMessage,
): ConversationView {
  return {
    ...view,
    messages: view.messages.map((message) =>
      message.id === messageId ? update(message) : message,
    ),
  };
}

function setMessageThinking(
  view: ConversationView,
  messageId: string,
  thinking: boolean,
): ConversationView {
  return updateMessage(view, messageId, (message) => ({ ...message, thinking }));
}

function clearRetryFields(): Pick<ConversationView, "retry" | "retryRunId"> {
  return { retry: undefined, retryRunId: undefined };
}

function clearRetry(view: ConversationView): ConversationView {
  return { ...view, ...clearRetryFields() };
}

function withActivities(
  view: ConversationView,
  event: Extract<ConversationChange, { type: "event" }>["event"],
): ConversationView {
  const message = view.messages.find((item) => item.id === event.runId);
  const activities = projectReplyActivity([...(message?.activities ?? [])], event);
  return {
    ...view,
    messages: view.messages.map((item) =>
      item.id === event.runId ? { ...item, activities } : item,
    ),
  };
}

function toViewMessage(
  message: ConversationMessage,
  prior?: ConversationViewMessage,
): ConversationViewMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    status: message.status,
    ...(prior?.thinking === undefined ? {} : { thinking: prior.thinking }),
    ...(prior?.reasoning === undefined ? {} : { reasoning: prior.reasoning }),
    ...(prior?.activities === undefined ? {} : { activities: prior.activities }),
    images: message.images,
  };
}

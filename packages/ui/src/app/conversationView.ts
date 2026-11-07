/** 唯一的 AgentEventEnvelope UI 投影：snapshot 初始化，随后由事件驱动状态。 */
import type {
  AgentEventEnvelope,
  AgentStreamEvent,
  ConversationMessage,
  ConversationSnapshot,
} from "@answra/shared";
import type {
  ConversationRetry,
  ConversationViewMessage,
} from "../components/chat/conversationMessage";
import { projectReplyActivity } from "./replyActivity";

export interface ConversationView {
  revision: number;
  messages: ConversationViewMessage[];
  activeRunId?: string;
  retry?: ConversationRetry;
  retryRunId?: string;
  error?: string;
}

export const EMPTY_CONVERSATION_VIEW: ConversationView = { revision: 0, messages: [] };

export interface ConversationProjectionOptions {
  retainCapturedRound?: boolean;
  trackActivities?: boolean;
}

export function eventRevision(event: AgentEventEnvelope): number {
  return event.aggregateRevision;
}

export function conversationOf(event: AgentEventEnvelope): string {
  return event.conversationId ?? "";
}

export function applyConversationSnapshot(
  view: ConversationView,
  snapshot: ConversationSnapshot,
  options: ConversationProjectionOptions = {},
): ConversationView {
  if (options.retainCapturedRound && snapshot.messages.length === 0 && view.messages.length > 0)
    return { ...view, activeRunId: undefined };
  const prior = new Map(view.messages.map((message) => [message.id, message]));
  return {
    revision: view.revision,
    messages: snapshot.messages.map((message) => toViewMessage(message, prior.get(message.id))),
    activeRunId: snapshot.activeRunId,
    retry: view.retry,
    retryRunId: view.retryRunId,
    error: view.error,
  };
}

export function applyAgentEvent(
  view: ConversationView,
  envelope: AgentEventEnvelope,
  options: ConversationProjectionOptions = {},
): ConversationView {
  if (envelope.aggregateRevision <= view.revision) return view;
  const event = envelope.event;
  let next = { ...view, revision: envelope.aggregateRevision };
  if (event.type === "run-state-changed") {
    if (["queued", "claimed", "running", "retry-wait"].includes(event.state)) {
      next = { ...next, activeRunId: envelope.runId };
      if (event.state === "retry-wait" && event.retry)
        next = { ...next, retry: event.retry, retryRunId: envelope.runId };
    } else {
      next = {
        ...next,
        activeRunId: next.activeRunId === envelope.runId ? undefined : next.activeRunId,
        messages: next.messages.map((message) =>
          message.id === envelope.runId
            ? {
                ...message,
                thinking: false,
                status: event.state === "failed" ? "failed" : message.status,
              }
            : message,
        ),
      };
    }
    return next;
  }
  const hasMessage = next.messages.some((message) => message.id === envelope.runId);
  if (!hasMessage) return event.type === "error" ? { ...next, error: event.errorText } : next;
  if (
    event.type === "step-started" ||
    event.type === "step-finished" ||
    event.type === "part-state-changed"
  )
    return next;
  return applyStreamEvent(next, envelope.runId, event, options);
}

function applyStreamEvent(
  view: ConversationView,
  runId: string,
  event: AgentStreamEvent,
  options: ConversationProjectionOptions,
): ConversationView {
  let next = view;
  switch (event.type) {
    case "retry":
      next = { ...next, retry: event, retryRunId: runId };
      break;
    case "reasoning-start":
      next = setThinking(next, runId, true);
      break;
    case "reasoning-delta":
      next = updateMessage(next, runId, (message) => ({
        ...message,
        thinking: true,
        reasoning: (message.reasoning ?? "") + event.delta,
      }));
      break;
    case "start":
      next = { ...setThinking(next, runId, false), retry: undefined, retryRunId: undefined };
      break;
    case "text-delta":
      next = updateMessage(next, runId, (message) => ({
        ...message,
        thinking: false,
        text: message.text + event.delta,
      }));
      break;
    case "error":
      next = { ...setThinking(next, runId, false), error: event.errorText };
      break;
    default:
      next = setThinking(next, runId, false);
  }
  if (options.trackActivities) {
    const message = next.messages.find((item) => item.id === runId);
    const activities = projectReplyActivity([...(message?.activities ?? [])], { runId, event });
    next = updateMessage(next, runId, (item) => ({ ...item, activities }));
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
): ConversationViewMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    status: message.status,
    images: message.images,
    ...(prior?.thinking === undefined ? {} : { thinking: prior.thinking }),
    ...(prior?.reasoning === undefined ? {} : { reasoning: prior.reasoning }),
    ...(prior?.activities === undefined ? {} : { activities: prior.activities }),
  };
}

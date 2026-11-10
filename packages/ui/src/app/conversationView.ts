/** 唯一的 AgentEventEnvelope UI 投影：snapshot 初始化，随后由事件驱动状态。 */
import type {
  AgentEventEnvelope,
  AgentStreamEvent,
  ConversationMessage,
  ConversationMessagePart,
  ConversationSnapshot,
  ReplyBarActivity,
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

export interface ConversationView {
  eventRevision: number;
  messages: ConversationViewMessage[];
  activeRunId?: string;
  retry?: ConversationRetry;
  retryRunId?: string;
  error?: string;
}

export const EMPTY_CONVERSATION_VIEW: ConversationView = { eventRevision: 0, messages: [] };

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
    return { ...view, eventRevision: snapshot.eventRevision, activeRunId: undefined };
  const prior = new Map(view.messages.map((message) => [message.id, message]));
  const keepRetry =
    snapshot.activeRunId !== undefined && snapshot.activeRunId === view.retryRunId && view.retry;
  return {
    eventRevision: snapshot.eventRevision,
    messages: snapshot.messages.map((message) =>
      toViewMessage(message, prior.get(message.id), snapshot.activeRunId === message.id),
    ),
    activeRunId: snapshot.activeRunId,
    retry: keepRetry ? view.retry : undefined,
    retryRunId: keepRetry ? view.retryRunId : undefined,
    // A snapshot is the server's current conversation truth. Do not carry a
    // terminal error from the previous run into a cleared or resumed view.
    error: undefined,
  };
}

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
      next = { ...next, activeRunId: envelope.runId };
      next = updateMessage(next, envelope.runId, (message) => ({
        ...message,
        waitingForStream: event.state === "claimed" || event.state === "running",
      }));
      if (event.state === "retry-wait" && event.retry)
        next = { ...next, retry: event.retry, retryRunId: envelope.runId };
    } else {
      const retryBelongsToRun = next.retryRunId === envelope.runId && next.retry !== undefined;
      const failed = messageStatus === "failed";
      const retry = next.retry;
      next = {
        ...next,
        activeRunId: next.activeRunId === envelope.runId ? undefined : next.activeRunId,
        retry: retryBelongsToRun
          ? failed && retry
            ? { ...retry, finished: true }
            : undefined
          : retry,
        retryRunId: retryBelongsToRun && !failed ? undefined : next.retryRunId,
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
  const hasMessage = next.messages.some((message) => message.id === envelope.runId);
  if (!hasMessage) return event.type === "error" ? { ...next, error: event.errorText } : next;
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
    case "start":
      next = {
        ...setThinking(next, runId, false),
        retry: undefined,
        retryRunId: undefined,
        error: undefined,
      };
      break;
    case "error":
      next = { ...setThinking(next, runId, false), error: event.errorText };
      break;
    default:
      next = updateMessage(next, runId, (message) => {
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
  activeRun = false,
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
    waitingForStream: prior?.thinking ? false : (prior?.waitingForStream ?? activeRun),
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

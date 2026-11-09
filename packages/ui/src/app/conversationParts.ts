/**
 * Conversation message part projection: the pure reducer that turns Agent stream events into
 * ordered text/reasoning/tool parts. It owns no React state and never mutates its input.
 */
import type { ConversationMessagePart } from "@answra/shared";
import type { AgentStreamEvent } from "@answra/shared/schema";

/**
 * Applies one stream event to a message's parts.
 * Returns `undefined` for events that do not change rendered message content.
 */
export function applyConversationPartEvent(
  parts: readonly ConversationMessagePart[],
  event: AgentStreamEvent,
): ConversationMessagePart[] | undefined {
  switch (event.type) {
    case "text-start":
      return upsertPart(parts, {
        id: event.partId,
        kind: "text",
        text: "",
        state: "started",
      });
    case "text-delta": {
      const current = findPart(parts, event.partId, "text");
      return upsertPart(parts, {
        id: event.partId,
        kind: "text",
        text: (current?.text ?? "") + event.delta,
        state: "streaming",
      });
    }
    case "text-end": {
      const current = findPart(parts, event.partId, "text");
      if (!current) return undefined;
      return upsertPart(parts, { ...current, state: "completed" });
    }
    case "reasoning-start":
      return upsertPart(parts, {
        id: event.partId,
        kind: "reasoning",
        text: "",
        state: "started",
      });
    case "reasoning-delta": {
      const current = findPart(parts, event.partId, "reasoning");
      return upsertPart(parts, {
        id: event.partId,
        kind: "reasoning",
        text: (current?.text ?? "") + event.delta,
        state: "streaming",
      });
    }
    case "reasoning-end": {
      const current = findPart(parts, event.partId, "reasoning");
      if (!current) return undefined;
      return upsertPart(parts, { ...current, state: "completed" });
    }
    case "tool-input-start":
      return upsertPart(parts, {
        id: event.toolCallId,
        kind: "tool",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...(event.title ? { title: event.title } : {}),
        state: "input-streaming",
      });
    case "tool-input-delta": {
      const current = findPart(parts, event.toolCallId, "tool");
      if (!current) return undefined;
      return upsertPart(parts, {
        ...current,
        inputText: (current.inputText ?? "") + event.delta,
        state: "input-streaming",
      });
    }
    case "tool-input-end": {
      const current = findPart(parts, event.toolCallId, "tool");
      if (!current) return undefined;
      return upsertPart(parts, { ...current, state: "pending" });
    }
    case "tool-call": {
      const current = findPart(parts, event.toolCallId, "tool");
      return upsertPart(parts, {
        id: event.toolCallId,
        kind: "tool",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...(current?.title ? { title: current.title } : {}),
        ...(current?.inputText ? { inputText: current.inputText } : {}),
        state: "pending",
        input: event.input,
      });
    }
    case "tool-approval-request": {
      const current = findPart(parts, event.toolCallId, "tool");
      return upsertPart(parts, {
        id: event.toolCallId,
        kind: "tool",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        state: "awaiting-approval",
        input: event.input,
        ...(current?.title ? { title: current.title } : {}),
      });
    }
    case "tool-execution-started": {
      const current = findPart(parts, event.toolCallId, "tool");
      if (!current) return undefined;
      return upsertPart(parts, { ...current, state: "running" });
    }
    case "tool-execution-finished": {
      const current = findPart(parts, event.toolCallId, "tool");
      if (!current) return undefined;
      return upsertPart(
        parts,
        event.result.success
          ? { ...current, state: "completed", output: event.result.output }
          : { ...current, state: "failed", errorText: event.result.errorText },
      );
    }
    case "tool-result": {
      const current = findPart(parts, event.toolCallId, "tool");
      if (!current) return undefined;
      return upsertPart(parts, { ...current, state: "completed", output: event.output });
    }
    case "tool-error": {
      const current = findPart(parts, event.toolCallId, "tool");
      if (!current) return undefined;
      return upsertPart(parts, { ...current, state: "failed", errorText: event.errorText });
    }
    case "tool-output-denied": {
      const current = findPart(parts, event.toolCallId, "tool");
      if (!current) return undefined;
      return upsertPart(parts, { ...current, state: "denied" });
    }
    default:
      return undefined;
  }
}

/** Settles every non-terminal part when a run ends abnormally. */
export function settleConversationParts(
  parts: readonly ConversationMessagePart[],
  state: "failed" | "interrupted",
): ConversationMessagePart[] {
  return parts.map((part) => {
    if (part.kind === "tool") {
      if (part.state === "completed" || part.state === "failed" || part.state === "denied")
        return part;
      return { ...part, state };
    }
    if (part.state === "completed" || part.state === "failed" || part.state === "interrupted")
      return part;
    return { ...part, state };
  });
}

export function textFromConversationParts(parts: readonly ConversationMessagePart[]): string {
  return parts
    .filter(
      (part): part is Extract<ConversationMessagePart, { kind: "text" }> => part.kind === "text",
    )
    .map((part) => part.text)
    .join("");
}

export function reasoningFromConversationParts(parts: readonly ConversationMessagePart[]): string {
  return parts
    .filter(
      (part): part is Extract<ConversationMessagePart, { kind: "reasoning" }> =>
        part.kind === "reasoning",
    )
    .map((part) => part.text)
    .join("\n\n");
}

function findPart<K extends ConversationMessagePart["kind"]>(
  parts: readonly ConversationMessagePart[],
  id: string,
  kind: K,
): Extract<ConversationMessagePart, { kind: K }> | undefined {
  const part = parts.find((item) => item.id === id);
  return part?.kind === kind ? (part as Extract<ConversationMessagePart, { kind: K }>) : undefined;
}

function upsertPart(
  parts: readonly ConversationMessagePart[],
  nextPart: ConversationMessagePart,
): ConversationMessagePart[] {
  const index = parts.findIndex((part) => part.id === nextPart.id);
  if (index < 0) return [...parts, nextPart];
  return parts.map((part, partIndex) => (partIndex === index ? nextPart : part));
}

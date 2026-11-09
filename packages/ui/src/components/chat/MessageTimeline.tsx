import type { ConversationMessagePart } from "@answra/shared";
import { resolveToolCallRenderer } from "../tool-call";
import type { ToolCallPart } from "../tool-call/toolCallPart";
import styles from "./MessageTimeline.module.css";
import { TextResponse } from "./TextResponse";
import { ThinkingReasoning } from "./ThinkingReasoning";

export type MessageTimelineSegment =
  | { kind: "text"; key: string; text: string; streaming: boolean }
  | { kind: "reasoning"; key: string; text: string; streaming: boolean }
  | { kind: "tool"; key: string; part: ToolCallPart };

interface MessageTimelineProps {
  parts: readonly ConversationMessagePart[];
  thinking: boolean;
  thinkingMs?: number;
  caret?: boolean;
}

/** Renders one assistant body in event order: thinking, text, and tool cards. */
export function MessageTimeline({ parts, thinking, thinkingMs, caret }: MessageTimelineProps) {
  const segments = groupMessageParts(parts);
  const lastTextIndex = lastIndexOfKind(segments, "text");
  const lastReasoningIndex = lastIndexOfKind(segments, "reasoning");
  const hasReasoning = lastReasoningIndex >= 0;

  return (
    <div className={styles.timeline}>
      {thinking && !hasReasoning ? (
        <ThinkingReasoning durationMs={thinkingMs} reasoning="" thinking />
      ) : null}
      {segments.map((segment, index) => {
        if (segment.kind === "tool") {
          const ToolRenderer = resolveToolCallRenderer(segment.part.toolName);
          return <ToolRenderer key={segment.key} part={segment.part} />;
        }
        if (segment.kind === "reasoning") {
          const active = thinking && index === lastReasoningIndex;
          if (!segment.text && !active) return null;
          return (
            <ThinkingReasoning
              durationMs={index === lastReasoningIndex ? thinkingMs : undefined}
              key={segment.key}
              reasoning={segment.text}
              thinking={active}
            />
          );
        }
        if (!segment.text.trim()) return null;
        return (
          <TextResponse
            caret={caret && index === lastTextIndex}
            key={segment.key}
            text={segment.text}
          />
        );
      })}
    </div>
  );
}

/** Groups adjacent text/reasoning parts while preserving tool boundaries and event order. */
export function groupMessageParts(
  parts: readonly ConversationMessagePart[],
): MessageTimelineSegment[] {
  const segments: MessageTimelineSegment[] = [];
  for (const part of parts) {
    if (part.kind === "tool") {
      segments.push({ kind: "tool", key: part.id, part });
      continue;
    }
    const last = segments.at(-1);
    if (last && last.kind === part.kind) {
      const separator = last.kind === "reasoning" && last.text && part.text ? "\n\n" : "";
      last.text += separator + part.text;
      last.streaming = last.streaming || part.state === "streaming";
      continue;
    }
    segments.push({
      kind: part.kind,
      key: part.id,
      text: part.text,
      streaming: part.state === "streaming",
    });
  }
  return segments;
}

function lastIndexOfKind(
  segments: readonly MessageTimelineSegment[],
  kind: MessageTimelineSegment["kind"],
): number {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index]?.kind === kind) return index;
  }
  return -1;
}

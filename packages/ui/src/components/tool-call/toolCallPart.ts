import type { ConversationMessagePart } from "@answra/shared";

export type ToolCallPart = Extract<ConversationMessagePart, { kind: "tool" }>;

export interface ToolCallRendererProps {
  part: ToolCallPart;
}

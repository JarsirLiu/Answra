/** Contracts shared by the conversation tool registry and its Agent-owned tools. */

export type ConversationToolId = "conversation.read" | "conversation.grep";

export interface ConversationToolContext {
  workspaceRoot: string | null;
  signal: AbortSignal;
}

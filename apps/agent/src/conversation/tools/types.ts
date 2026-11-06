/** Conversation 工具注册表与 Agent 工具实现共享的契约。 */

export type ConversationToolId = "conversation.read" | "conversation.grep";

export interface ConversationToolContext {
  workspaceRoot: string | null;
  signal: AbortSignal;
}

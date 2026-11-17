/** 会话历史目录端口；列表与删除独立于 transcript 写入语义。 */
import type { ConversationSessionPage, ConversationSessionScope } from "@answra/shared";

export interface ConversationSessionQuery {
  scope?: ConversationSessionScope;
  workspaceRoot?: string;
  cursor?: string;
  limit?: number;
}

export interface ConversationSessionCatalog {
  list(query?: ConversationSessionQuery): Promise<ConversationSessionPage>;
  delete(conversationId: string): Promise<void>;
}

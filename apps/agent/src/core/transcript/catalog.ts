/** 会话历史目录端口；列表、消息页与删除独立于 transcript 写入语义。 */
import type {
  ConversationMessage,
  ConversationSessionPage,
  ConversationSessionScope,
  ConversationSessionSummary,
} from "@answra/shared";

export interface ConversationSessionQuery {
  scope?: ConversationSessionScope;
  workspaceRoot?: string;
  cursor?: string;
  limit?: number;
}

export interface ConversationSessionCatalog {
  list(query?: ConversationSessionQuery): Promise<ConversationSessionPage>;
  /** 按完整 ID 直查摘要；用于不受分页窗口限制的恢复/删除。 */
  getSession(
    conversationId: string,
    workspaceRoot?: string,
  ): Promise<ConversationSessionSummary | undefined>;
  delete(conversationId: string): Promise<void>;
}

export interface ConversationMessageQuery {
  /** 调用方声明的 scope；与会话实际 scope 不一致时拒绝。 */
  scope?: ConversationSessionScope;
  cursor?: string;
  limit?: number;
}

export interface ConversationMessagePage {
  items: ConversationMessage[];
  nextCursor?: string;
}

export interface ConversationMessageCatalog {
  listMessages(
    conversationId: string,
    query?: ConversationMessageQuery,
  ): Promise<ConversationMessagePage>;
}

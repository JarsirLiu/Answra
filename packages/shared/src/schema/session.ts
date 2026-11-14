import { z } from "zod";

/** 会话所属产品面；历史列表按 scope 隔离，不靠 conversationId 前缀猜场景。 */
export const conversationSessionScopeSchema = z.enum([
  "coding",
  "conversation",
  "answer",
  "interview",
]);

/** 可跨 IPC 的会话摘要；不包含消息正文、工具输出或摘要检查点。 */
export const conversationSessionSummarySchema = z.strictObject({
  conversationId: z.string(),
  scope: conversationSessionScopeSchema,
  title: z.string(),
  messageCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  workspaceRoot: z.string().optional(),
});

export type ConversationSessionScope = z.infer<typeof conversationSessionScopeSchema>;
export type ConversationSessionSummary = z.infer<typeof conversationSessionSummarySchema>;

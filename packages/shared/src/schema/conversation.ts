import { z } from "zod";
import {
  agentMessageStateSchema,
  agentPartStateSchema,
  agentToolCallStateSchema,
  contextCompactionBoundarySchema,
  contextCompactionSchema,
  contextPruningSchema,
  contextUsageSchema,
} from "./status";

/** Conversation transcript messages and snapshots; event facts live in events.ts. */
const textPartSchema = z.strictObject({
  id: z.string(),
  kind: z.literal("text"),
  text: z.string(),
  state: agentPartStateSchema,
});
const reasoningPartSchema = z.strictObject({
  id: z.string(),
  kind: z.literal("reasoning"),
  text: z.string(),
  state: agentPartStateSchema,
});
const toolPartSchema = z.strictObject({
  id: z.string(),
  kind: z.literal("tool"),
  toolCallId: z.string(),
  toolName: z.string(),
  title: z.string().optional(),
  state: agentToolCallStateSchema,
  input: z.unknown().optional(),
  inputText: z.string().optional(),
  output: z.unknown().optional(),
  errorText: z.string().optional(),
});
export const conversationMessagePartSchema = z.discriminatedUnion("kind", [
  textPartSchema,
  reasoningPartSchema,
  toolPartSchema,
]);
/** Who a message is addressed to; user-visible messages omit the bot audience. */
export const messageAudienceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user") }),
  z.strictObject({ kind: z.literal("bot"), agentId: z.string() }),
]);
export const conversationMessageSchema = z.strictObject({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  /** Bot that authored the message; absent for user messages and legacy messages. */
  authorAgentId: z.string().optional(),
  /** Addressee of the message; absent means user-visible (legacy transcript shape). */
  audience: messageAudienceSchema.optional(),
  text: z.string(),
  images: z.array(z.strictObject({ name: z.string(), dataUrl: z.string() })),
  status: agentMessageStateSchema,
  parts: z.array(conversationMessagePartSchema).optional(),
  reasoning: z.string().optional(),
});

const conversationBotSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  role: z.string(),
});
export const conversationSnapshotSchema = z.strictObject({
  conversationId: z.string(),
  /** Conversation event revision before the most recent run; UI replays that run from the event store. */
  eventRevision: z.number().int().nonnegative(),
  messages: z.array(conversationMessageSchema),
  activeRunId: z.string().optional(),
  /** Bot that currently owns the conversation; absent for single-Agent conversations. */
  activeAgentId: z.string().optional(),
  /** Bots allowed to participate in this conversation. */
  participantAgentIds: z.array(z.string()).optional(),
  /** Display identity for the participants; UI uses it for author and current-Bot labels. */
  bots: z.array(conversationBotSchema).optional(),
  /** 最近一次上下文摘要压缩状态；缺省表示从未压缩或尚未触发。 */
  contextCompaction: contextCompactionSchema.optional(),
  /** 已成功摘要的边界；可随 snapshot 回放，不包含摘要正文。 */
  contextCompactionBoundaries: z.array(contextCompactionBoundarySchema).optional(),
  /** 最近一次模型请求的上下文占用与阈值；缺省表示尚未准备过请求。 */
  contextUsage: contextUsageSchema.optional(),
  /** 最近一次实际应用的旧工具结果清理；缺省表示最近一次请求未清理。 */
  contextPruning: contextPruningSchema.optional(),
});

/** One persisted content event; seq is per run and revision is per session. */
export type MessageAudience = z.infer<typeof messageAudienceSchema>;
export type ConversationBot = z.infer<typeof conversationBotSchema>;
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type ConversationMessagePart = z.infer<typeof conversationMessagePartSchema>;
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;

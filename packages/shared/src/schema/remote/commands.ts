import { z } from "zod";
import { remoteLocalModelInputSchema, remoteModelConfigSchema } from "./modelSettings";

export const REMOTE_SESSION_LIST_MAX_LIMIT = 200;

const remoteImageSchema = z.strictObject({
  name: z.string(),
  dataUrl: z.string(),
});

export const remoteSessionListQuerySchema = z.strictObject({
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(REMOTE_SESSION_LIST_MAX_LIMIT).optional(),
});

const remoteSendRequestSchema = z.strictObject({
  text: z.string(),
  images: z.array(remoteImageSchema),
});

/** 远程命令面首版开放 chat/team；answer.run 不进远程命令面。 */
export const remoteSendCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("chat.send"),
    conversationId: z.string(),
    botId: z.string().optional(),
    request: remoteSendRequestSchema,
  }),
  z.strictObject({
    operation: z.literal("team.send"),
    conversationId: z.string(),
    teamId: z.string(),
    request: remoteSendRequestSchema,
  }),
]);

export const remoteConversationSelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("bot"), botId: z.string() }),
  z.strictObject({ kind: z.literal("team"), teamId: z.string() }),
]);

export const remoteCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("create-conversation"),
    conversationId: z.string(),
    selection: remoteConversationSelectionSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("clear-conversation"),
    conversationId: z.string(),
  }),
  z.strictObject({
    type: z.literal("send"),
    command: remoteSendCommandSchema,
  }),
  z.strictObject({
    type: z.literal("wait-queue"),
    conversationId: z.string(),
    queueId: z.string(),
  }),
  z.strictObject({
    type: z.literal("wait-queue-start"),
    conversationId: z.string(),
    queueId: z.string(),
  }),
  z.strictObject({
    type: z.literal("cancel"),
    conversationId: z.string(),
    turnId: z.string(),
  }),
  z.strictObject({
    type: z.literal("snapshot"),
    conversationId: z.string(),
  }),
  z.strictObject({
    type: z.literal("read-events"),
    conversationId: z.string(),
    afterRevision: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("list-sessions"),
    query: remoteSessionListQuerySchema.optional(),
  }),
  z.strictObject({
    type: z.literal("list-bots"),
  }),
  z.strictObject({
    type: z.literal("select-bot"),
    conversationId: z.string(),
    botId: z.string(),
  }),
  z.strictObject({
    type: z.literal("apply-model"),
    config: remoteModelConfigSchema,
  }),
  z.strictObject({
    type: z.literal("settings-snapshot"),
  }),
  z.strictObject({
    type: z.literal("settings-add-local"),
    input: remoteLocalModelInputSchema,
  }),
  z.strictObject({
    type: z.literal("settings-switch-chat-model"),
    chatModel: z.string(),
  }),
  z.strictObject({
    type: z.literal("settings-clear-local"),
  }),
]);

export type RemoteImage = z.infer<typeof remoteImageSchema>;
export type RemoteSendRequest = z.infer<typeof remoteSendRequestSchema>;
export type RemoteSendCommand = z.infer<typeof remoteSendCommandSchema>;
export type RemoteConversationSelection = z.infer<typeof remoteConversationSelectionSchema>;
export type RemoteSessionListQuery = z.infer<typeof remoteSessionListQuerySchema>;
export type RemoteCommand = z.infer<typeof remoteCommandSchema>;

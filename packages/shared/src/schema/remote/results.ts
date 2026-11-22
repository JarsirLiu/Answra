import { z } from "zod";
import { botSummarySchema } from "../bot";
import { conversationSnapshotSchema } from "../conversation";
import { sessionFrameSchema } from "../session/frame";
import { turnOutcomeSchema } from "../status";

/** 远程命令成功响应的运行时契约；controller 不得直接 cast 未校验的 value。 */
export const remoteSendResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    queueId: z.string(),
    status: z.literal("started"),
    position: z.literal(0),
    turnId: z.string(),
    snapshot: conversationSnapshotSchema,
  }),
  z.strictObject({
    queueId: z.string(),
    status: z.literal("queued"),
    position: z.number().int().nonnegative(),
  }),
]);

export const remoteQueueCompletionSchema = z.strictObject({
  queueId: z.string(),
  turnId: z.string().optional(),
  outcome: turnOutcomeSchema,
});

export const remoteQueueStartSchema = z.strictObject({
  queueId: z.string(),
  turnId: z.string(),
  snapshot: conversationSnapshotSchema,
});

export const remoteFrameListSchema = z.array(sessionFrameSchema);
export const remoteBotListSchema = z.array(botSummarySchema);

export type RemoteSendResult = z.infer<typeof remoteSendResultSchema>;
export type RemoteQueueCompletion = z.infer<typeof remoteQueueCompletionSchema>;
export type RemoteQueueStart = z.infer<typeof remoteQueueStartSchema>;
export type RemoteFrameList = z.infer<typeof remoteFrameListSchema>;
export type RemoteBotList = z.infer<typeof remoteBotListSchema>;

import { z } from "zod";
import { botSummarySchema } from "../bot";
import { conversationSnapshotSchema } from "../conversation";
import { agentEventEnvelopeSchema } from "../events";
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

export const remoteEventListSchema = z.array(agentEventEnvelopeSchema);
export const remoteBotListSchema = z.array(botSummarySchema);

export type RemoteSendResult = z.infer<typeof remoteSendResultSchema>;
export type RemoteQueueCompletion = z.infer<typeof remoteQueueCompletionSchema>;
export type RemoteQueueStart = z.infer<typeof remoteQueueStartSchema>;
export type RemoteEventList = z.infer<typeof remoteEventListSchema>;
export type RemoteBotList = z.infer<typeof remoteBotListSchema>;

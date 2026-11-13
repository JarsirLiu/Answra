import { z } from "zod";
import { agentEventEnvelopeSchema } from "../events";

/** 重连时按 revision 补齐事件；host 不依赖服务端历史。 */
export const remoteEventBatchSchema = z.strictObject({
  events: z.array(agentEventEnvelopeSchema),
  throughRevision: z.number().int().nonnegative(),
});

export type RemoteEventBatch = z.infer<typeof remoteEventBatchSchema>;

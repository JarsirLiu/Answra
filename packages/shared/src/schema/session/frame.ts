import { z } from "zod";
import {
  agentDurableEventSchema,
  agentLiveOnlyEventSchema,
  type SessionEventEnvelope,
} from "../events";
import { sessionItemSchema } from "./item";

/** `SessionFrame` 的协议版本；v1 是迁移期的 `SessionEventEnvelope`。 */
export const SESSION_FRAME_SCHEMA_VERSION = 2 as const;

/**
 * 条目帧：一条已结算的会话条目。
 *
 * 与 durable 事件共用同一个 `seq` 游标；条目是持久化事实，事件从 P2b 起只走 live 通道。
 * 传输层复用 `sessionFrameSchema`，因此 remote / mobile 不需要单独适配。
 */
const sessionItemFrameEventSchema = z.strictObject({
  type: z.literal("session-item"),
  item: sessionItemSchema,
});

export const sessionFrameEventSchema = z.union([
  agentDurableEventSchema,
  sessionItemFrameEventSchema,
]);

/**
 * durable 通道的传输单位：会话事实 + 路由字段 + 会话内连续 `seq`。
 *
 * 只承载事实，不承载派生生命周期；客户端按 `seq` 补齐，没有第二份状态副本。
 */
export const sessionFrameSchema = z.strictObject({
  schemaVersion: z.literal(SESSION_FRAME_SCHEMA_VERSION),
  sessionId: z.string(),
  seq: z.number().int().positive(),
  eventId: z.string(),
  occurredAt: z.string().datetime(),
  producerId: z.string(),
  turnId: z.string().optional(),
  messageId: z.string().optional(),
  stepId: z.string().optional(),
  operationId: z.string().optional(),
  event: sessionFrameEventSchema,
});

/**
 * live 通道的传输单位：只承载高频增量。
 *
 * 无 `seq`、无 `eventId`，不参与重放；丢失只影响瞬时观感，完整值由 durable 事件给出。
 */
export const liveFrameSchema = z.strictObject({
  sessionId: z.string(),
  messageId: z.string(),
  stepId: z.string().optional(),
  event: agentLiveOnlyEventSchema,
});

export type SessionFrame = z.infer<typeof sessionFrameSchema>;
export type LiveFrame = z.infer<typeof liveFrameSchema>;

/** 迁移期适配：journal v1 envelope 与 v2 frame 只差版本号与 `sequence`/`seq` 命名。 */
export function toSessionFrame(envelope: SessionEventEnvelope): SessionFrame {
  return {
    schemaVersion: SESSION_FRAME_SCHEMA_VERSION,
    sessionId: envelope.sessionId,
    seq: envelope.sequence,
    eventId: envelope.eventId,
    occurredAt: envelope.occurredAt,
    producerId: envelope.producerId,
    ...(envelope.turnId === undefined ? {} : { turnId: envelope.turnId }),
    ...(envelope.messageId === undefined ? {} : { messageId: envelope.messageId }),
    ...(envelope.stepId === undefined ? {} : { stepId: envelope.stepId }),
    ...(envelope.operationId === undefined ? {} : { operationId: envelope.operationId }),
    event: envelope.event,
  };
}

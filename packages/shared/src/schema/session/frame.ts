import { z } from "zod";
import { agentLiveOnlyEventSchema } from "../events";
import { type SessionItem, sessionItemSchema } from "./item";

/** `SessionFrame` 的协议版本；v2 起 durable 通道只承载已结算条目。 */
export const SESSION_FRAME_SCHEMA_VERSION = 2 as const;

/** 条目帧：一条已结算的会话条目，与 live 增量共用 `sessionId`。 */
const sessionItemFrameEventSchema = z.strictObject({
  type: z.literal("session-item"),
  item: sessionItemSchema,
});

/**
 * durable 通道的传输单位：一条已结算条目 + 路由字段 + 会话内连续 `seq`。
 *
 * 只承载事实，不承载派生生命周期；Turn/用量等会话状态由快照给出，
 * 高频增量只走 `liveFrameSchema`。客户端按 `seq` 补齐，没有第二份状态副本。
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
  event: sessionItemFrameEventSchema,
});

/**
 * live 通道的传输单位：只承载高频增量与可丢的运行提示。
 *
 * 无 `seq`、无 `eventId`，不参与重放；丢失只影响瞬时观感，完整值由条目或快照给出。
 */
export const liveFrameSchema = z.strictObject({
  sessionId: z.string(),
  messageId: z.string(),
  stepId: z.string().optional(),
  event: agentLiveOnlyEventSchema,
});

export type SessionFrame = z.infer<typeof sessionFrameSchema>;
export type LiveFrame = z.infer<typeof liveFrameSchema>;

/**
 * 条目 → durable 帧。`seq` 已在写入时分配，帧只做承载；`eventId` 由会话与 seq 派生，
 * 保证同一事实重复读取得到同一身份。
 */
export function toSessionItemFrame(
  sessionId: string,
  item: SessionItem,
  producerId: string,
): SessionFrame {
  return {
    schemaVersion: SESSION_FRAME_SCHEMA_VERSION,
    sessionId,
    seq: item.seq,
    eventId: `${sessionId}:${item.seq}`,
    occurredAt: item.createdAt,
    producerId,
    ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
    ...(item.messageId === undefined ? {} : { messageId: item.messageId }),
    event: { type: "session-item", item },
  };
}

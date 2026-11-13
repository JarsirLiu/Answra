import { z } from "zod";

/**
 * 官方 AnswraSite 基地址；CLI 与桌面端共用同一站点。
 * 官方客户端固定使用，不提供用户覆盖入口。
 */
export const REMOTE_SERVICE_BASE_URL = "https://colorect.cloud";

/** 官方客户端的远程服务固定路径；不提供用户覆盖入口。 */
export const REMOTE_SIGNALING_TICKET_PATH = "/api/v1/remote/signaling-ticket";
export const REMOTE_SIGNALING_PATH = "/api/v1/remote/signaling";
export const REMOTE_SIGNALING_SUBPROTOCOL = "answra.remote.signaling.v1";

/** 一次性信令 ticket 只负责建立 WebSocket，不承载长期账号 token。 */
export const REMOTE_SIGNALING_TICKET_TTL_SECONDS = 60;

export const REMOTE_SIGNALING_MAX_FRAME_BYTES = 64 * 1024;

/** WebRTC DataChannel 的固定标签与子协议；浏览器 controller 必须使用同一值。 */
export const REMOTE_DATA_CHANNEL_LABEL = "answra.remote";
export const REMOTE_DATA_CHANNEL_PROTOCOL = "answra.remote.v1";

export const remoteSignalingTicketSchema = z.strictObject({
  ticket: z.string().min(1),
  expiresAt: z.string().min(1),
});

export type RemoteSignalingTicket = z.infer<typeof remoteSignalingTicketSchema>;

/** 组合 ticket、WebSocket 与信令房间状态机；host/controller 只拿到已 join 的会话。 */
import { RemoteSignalingSession, type RemoteSignalingTimers } from "@answra/remote";
import type { RemoteRole } from "@answra/shared/schema";
import type { RemoteSignalingService } from "./remoteSignalingService";

export interface ConnectRemoteSignalingOptions {
  service: RemoteSignalingService;
  timers: RemoteSignalingTimers;
  role: RemoteRole;
  roomId: string;
  peerId: string;
  joinTimeoutMs?: number;
}

export async function connectRemoteSignaling({
  service,
  timers,
  role,
  roomId,
  peerId,
  joinTimeoutMs,
}: ConnectRemoteSignalingOptions): Promise<RemoteSignalingSession> {
  const ticket = await service.requestTicket();
  const channel = service.openChannel(ticket.ticket);
  const session = new RemoteSignalingSession({
    channel,
    roomId,
    peerId,
    role,
    timers,
    ...(joinTimeoutMs === undefined ? {} : { joinTimeoutMs }),
  });

  try {
    await session.join();
    return session;
  } catch (error) {
    session.close();
    throw error;
  }
}

/** AnswraSite 信令服务适配：换取一次性 ticket 并建立已鉴权的 WebSocket 通道。 */

import type { SignalingChannel } from "@answra/remote";
import { RemoteOperationError, remoteError } from "@answra/remote";
import {
  REMOTE_SERVICE_BASE_URL,
  REMOTE_SIGNALING_PATH,
  REMOTE_SIGNALING_SUBPROTOCOL,
  REMOTE_SIGNALING_TICKET_PATH,
  type RemoteSignalingTicket,
  remoteSignalingTicketSchema,
} from "@answra/shared/schema";
import { type WebSocketLike, WebSocketSignalingChannel } from "./webSocketSignalingChannel";

/** 只暴露 ticket 与信令通道；host/controller 组合根不接触 HTTP 或 WebSocket。 */
export interface RemoteSignalingService {
  requestTicket(): Promise<RemoteSignalingTicket>;
  openChannel(ticket: string): SignalingChannel;
}

export interface CreateRemoteSignalingServiceOptions {
  baseUrl?: string;
  getAccessToken: () => Promise<string>;
  fetch?: FetchLike;
  createSocket?: (url: string, protocols: readonly string[]) => WebSocketLike;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 官方端点固定；测试通过注入 baseUrl/fetch/createSocket 隔离网络。 */
export function createRemoteSignalingService({
  baseUrl = REMOTE_SERVICE_BASE_URL,
  getAccessToken,
  fetch: fetchImpl = globalThis.fetch,
  createSocket = createGlobalWebSocket,
}: CreateRemoteSignalingServiceOptions): RemoteSignalingService {
  return {
    async requestTicket() {
      const accessToken = await getAccessToken();
      return requestRemoteSignalingTicket({ baseUrl, accessToken, fetch: fetchImpl });
    },
    openChannel(ticket) {
      return new WebSocketSignalingChannel({
        url: buildRemoteSignalingUrl({ baseUrl, ticket }),
        protocols: [REMOTE_SIGNALING_SUBPROTOCOL],
        createSocket,
      });
    },
  };
}

export interface RequestRemoteSignalingTicketOptions {
  baseUrl?: string;
  accessToken: string;
  fetch: FetchLike;
}

/** `POST /api/v1/remote/signaling-ticket`；ticket 只用于一次 WS 握手。 */
export async function requestRemoteSignalingTicket({
  baseUrl = REMOTE_SERVICE_BASE_URL,
  accessToken,
  fetch: fetchImpl,
}: RequestRemoteSignalingTicketOptions): Promise<RemoteSignalingTicket> {
  const token = accessToken.trim();
  if (token === "") {
    throw new RemoteOperationError(
      remoteError("unauthorized", "remote service access token is not configured"),
    );
  }

  let response: Response;
  try {
    response = await fetchImpl(new URL(REMOTE_SIGNALING_TICKET_PATH, baseUrl).toString(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
    });
  } catch {
    throw new RemoteOperationError(
      remoteError("remote-unreachable", "failed to reach the remote signaling service", true),
    );
  }

  if (!response.ok) {
    throw new RemoteOperationError(
      remoteError(
        response.status === 401 || response.status === 403 ? "unauthorized" : "remote-unreachable",
        `remote signaling ticket request failed with HTTP ${response.status}`,
        response.status === 429 || response.status >= 500,
      ),
    );
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new RemoteOperationError(
      remoteError("invalid-frame", "remote signaling ticket response is not JSON"),
    );
  }

  const parsed = remoteSignalingTicketSchema.safeParse(value);
  if (!parsed.success) {
    throw new RemoteOperationError(
      remoteError("invalid-frame", "remote signaling ticket response is invalid"),
    );
  }
  if (Date.parse(parsed.data.expiresAt) <= Date.now()) {
    throw new RemoteOperationError(
      remoteError("timeout", "remote signaling ticket is already expired", true),
    );
  }
  return parsed.data;
}

export function buildRemoteSignalingUrl({
  baseUrl = REMOTE_SERVICE_BASE_URL,
  ticket,
}: {
  baseUrl?: string;
  ticket: string;
}): string {
  const url = new URL(REMOTE_SIGNALING_PATH, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

interface WebSocketConstructor {
  new (url: string, protocols?: string | readonly string[]): WebSocketLike;
}

/** Node 22 内置 WebSocket；运行时缺失时在打开通道前显式失败。 */
export function createGlobalWebSocket(url: string, protocols: readonly string[]): WebSocketLike {
  const Constructor = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
  if (Constructor === undefined) {
    throw new Error("当前运行时没有可用的 WebSocket 实现。");
  }
  return new Constructor(url, [...protocols]);
}

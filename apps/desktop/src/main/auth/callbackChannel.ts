import { AUTH_CALLBACK_URL } from "./authorizeUrl";
import { startLoopbackCallback } from "./loopbackCallback";

/**
 * 回调接收通道。
 *
 * - 打包版 = 自定义 scheme 深链：URL 由系统交给应用，经 `AuthService.handleCallbackUrl` 注入，
 *   通道本身只是声明 `redirect_uri`。
 * - 开发态 = 环回 HTTP（`loopbackCallback.ts`），每次登录起一个临时服务。
 */
export interface AuthCallbackChannel {
  begin(onCallback: (url: string) => void): Promise<{ redirectUri: string; close(): void }>;
}

export const deepLinkCallbackChannel: AuthCallbackChannel = {
  begin: async () => ({ redirectUri: AUTH_CALLBACK_URL, close: () => undefined }),
};

/** 开发态环回通道；`startLoopbackCallback` 在打包版直接拒绝。 */
export const loopbackCallbackChannel: AuthCallbackChannel = {
  begin: (onCallback) => startLoopbackCallback(onCallback),
};

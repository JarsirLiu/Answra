import path from "node:path";
import { app } from "electron";
import { AUTH_SCHEME } from "./authorizeUrl";
import { findAuthCallbackUrl } from "./callback";

/**
 * 深链生命周期：自定义 scheme 注册 + 回调 URL 路由。
 *
 * 平台差异：
 * - macOS 走 `open-url`，**必须在 app ready 之前注册**，否则冷启动的授权回跳会丢事件；
 * - Windows/Linux 走 `second-instance`，从 argv 里捞回调 URL（配合单实例锁）；
 * - 开发态注册要带 `process.execPath` + 入口脚本路径，否则系统不知道如何转发给 dev 进程。
 */

const AUTH_PROTOCOL_SCHEME = AUTH_SCHEME;

export interface AuthLifecycleOptions {
  onCallbackUrl: (url: string) => void;
  /** argv 里没有回调 URL 时的兜底（如用户重复点击图标）。 */
  onSecondInstance?: (argv: readonly string[]) => void;
}

/** 计算 `setAsDefaultProtocolClient` 的三个参数（打包版与开发态不同）。 */
export function protocolClientRegistration(options: {
  defaultApp: boolean;
  execPath: string;
  entry: string | undefined;
}): { scheme: string; execPath?: string; args?: string[] } {
  if (options.defaultApp && options.entry) {
    return {
      scheme: AUTH_PROTOCOL_SCHEME,
      execPath: options.execPath,
      args: [path.resolve(options.entry)],
    };
  }
  return { scheme: AUTH_PROTOCOL_SCHEME };
}

export function registerProtocolClient(): void {
  const registration = protocolClientRegistration({
    defaultApp: Boolean(process.defaultApp),
    execPath: process.execPath,
    entry: process.argv[1],
  });
  if (registration.execPath && registration.args) {
    app.setAsDefaultProtocolClient(registration.scheme, registration.execPath, registration.args);
    return;
  }
  app.setAsDefaultProtocolClient(registration.scheme);
}

export function registerAuthLifecycle(options: AuthLifecycleOptions): void {
  registerProtocolClient();
  app.on("open-url", (event, url) => {
    event.preventDefault();
    options.onCallbackUrl(url);
  });
  app.on("second-instance", (_event, argv) => {
    const url = findAuthCallbackUrl(argv);
    if (url) {
      options.onCallbackUrl(url);
      return;
    }
    options.onSecondInstance?.(argv);
  });
}

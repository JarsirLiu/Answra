import { createServer } from "node:http";
import { app } from "electron";

/**
 * 仅开发态的环回回调（`http://127.0.0.1:<ephemeral>/auth/callback`）。
 *
 * 为什么需要：开发态下 `answra://` 注册依赖 `process.execPath` + 脚本路径，热重载与多实例
 * 体验很差；环回回调让 `pnpm dev` 能完整跑通授权回跳。
 *
 * 硬约束（架构守护 `forbidLocalListeners` 断言本文件）：
 * - 只绑定 `127.0.0.1`，绝不监听 `0.0.0.0`；
 * - 打包版直接抛错，产物中不可能启用（`app.isPackaged` 必须在场）。
 */

export const LOOPBACK_HOST = "127.0.0.1";
export const LOOPBACK_PATH = "/auth/callback";

export interface LoopbackCallbackServer {
  redirectUri: string;
  close(): void;
}

const RESPONSE_BODY = [
  '<!doctype html><html lang="zh"><meta charset="utf-8">',
  "<title>Answra</title>",
  '<body style="font-family:system-ui;padding:40px">',
  "<h1>登录完成</h1><p>可以关闭这个标签页，回到 Answra 桌面端。</p>",
  "</body></html>",
].join("");

export function startLoopbackCallback(
  onCallback: (url: string) => void,
): Promise<LoopbackCallbackServer> {
  if (app.isPackaged) {
    return Promise.reject(new Error("打包版禁止使用环回回调，必须走 answra:// 深链"));
  }
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = request.url ?? "/";
      if (!url.startsWith(LOOPBACK_PATH)) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("not found");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(RESPONSE_BODY);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      onCallback(`http://${LOOPBACK_HOST}:${port}${url}`);
    });
    let settled = false;
    server.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    server.listen({ host: LOOPBACK_HOST, port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      settled = true;
      resolve({
        redirectUri: `http://${LOOPBACK_HOST}:${port}${LOOPBACK_PATH}`,
        close: () => server.close(),
      });
    });
  });
}

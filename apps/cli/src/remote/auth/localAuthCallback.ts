/** CLI 本地 OAuth 回调：只接收一次 code/state，然后关闭临时 HTTP 监听。 */
import { createServer } from "node:http";
import { URL } from "node:url";
import type { AuthorizationCallbackReceiver } from "./remoteAuthService";

const CALLBACK_PATH = "/auth/callback";

export async function createLocalAuthorizationCallback(): Promise<AuthorizationCallbackReceiver> {
  let resolveResult: ((value: string) => void) | undefined;
  let rejectResult: ((error: Error) => void) | undefined;
  let settled = false;
  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end();
      return;
    }
    const code = requestUrl.searchParams.get("code");
    const state = requestUrl.searchParams.get("state");
    if (code === null || state === null || code === "" || state === "") {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end("<h1>登录回调无效</h1><p>请关闭此页面并重新运行 CLI 登录。</p>");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Answra CLI 登录完成</title>
    <style>
      :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #171817; color: #f4f3ef; }
      main { width: min(420px, calc(100vw - 40px)); box-sizing: border-box; padding: 36px; border: 1px solid #3b3d39; border-radius: 16px; background: #20221f; box-shadow: 0 18px 60px #0008; }
      .brand { display: flex; align-items: center; gap: 12px; color: #f59575; font-weight: 650; letter-spacing: .01em; }
      .owl { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 12px; background: #d77757; color: #20221f; font-size: 25px; }
      h1 { margin: 30px 0 10px; font-size: 26px; line-height: 1.2; }
      p { margin: 0; color: #b7b9b3; font-size: 15px; line-height: 1.6; }
      .hint { margin-top: 24px; padding-top: 18px; border-top: 1px solid #3b3d39; font-size: 13px; color: #858980; }
    </style>
  </head>
  <body>
    <main>
      <div class="brand"><span class="owl" aria-hidden="true">◉</span><span>Answra CLI</span></div>
      <h1>登录已完成</h1>
      <p>授权结果已自动发送到 CLI。现在可以返回终端继续使用。</p>
      <p class="hint">此页面可以安全关闭。</p>
    </main>
  </body>
</html>`);
    if (!settled) {
      settled = true;
      resolveResult?.(`${code}#${state}`);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("无法启动本地登录回调服务。");
  }
  return {
    redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
    wait: () => result,
    close: async () => {
      if (!settled) {
        settled = true;
        rejectResult?.(new Error("登录已取消。"));
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

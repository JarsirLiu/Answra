/** `answra auth` 用例：登录、查看状态与登出；不接触 keychain 或 HTTP 细节。 */
import type { RemoteAuthStatus } from "../remote/auth/remoteAuthService";
import type { CliDependencies } from "./dependencies";

export type AuthCommandOptions =
  | { kind: "auth"; action: "login" }
  | { kind: "auth"; action: "status" }
  | { kind: "auth"; action: "logout" };

export async function runAuthCommand(
  options: AuthCommandOptions,
  deps: CliDependencies,
): Promise<number> {
  const auth = deps.remoteAuth;
  if (auth === undefined) throw new Error("当前环境未配置账号登录。");

  if (options.action === "login") {
    const status = await auth.login({
      onAuthorizeUrl: async (url) => {
        deps.output.write(`在浏览器打开以下地址登录：\n${url}\n\n`);
        if (deps.openBrowser === undefined) return;
        try {
          await deps.openBrowser(url);
        } catch {
          deps.output.write("无法自动打开浏览器，请手动访问上面的地址。\n");
        }
      },
    });
    deps.output.write(`登录成功${accountSuffix(status)}。\n`);
    return 0;
  }

  if (options.action === "status") {
    const status = await auth.status();
    if (!status.signedIn) {
      deps.output.write("未登录。运行 `answra auth login` 登录。\n");
      return 0;
    }
    const expiry = status.expiresAt === null ? "" : `，有效期至 ${formatTime(status.expiresAt)}`;
    deps.output.write(`已登录${accountSuffix(status)}${expiry}。\n`);
    return 0;
  }

  await auth.logout();
  deps.output.write("已退出登录。\n");
  return 0;
}

function accountSuffix(status: RemoteAuthStatus): string {
  return status.account === null ? "" : `（${status.account}）`;
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

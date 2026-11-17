/** 远程类命令：/remote；只执行，不判断运行状态。 */
import { RemoteAuthRequiredError } from "../../../remote/auth/remoteAuthService";
import type { TuiNotification } from "../../notices/notification";
import type { RemoteHostHandle, RemoteHostInfo, TuiCommandDeps } from "../ports";

const REMOTE_NOTICE_KEY = "remote";
const REMOTE_NOTICE_TIMEOUT_MS = 30_000;

export async function handleRemote(args: readonly string[], deps: TuiCommandDeps): Promise<void> {
  if (args.length > 0) {
    notify(deps, "/remote 不接受参数。", "warning");
    return;
  }
  if (deps.startRemoteHost === undefined) {
    notify(deps, "当前环境未配置远程连接。", "warning");
    return;
  }
  const existing = deps.activeRemote?.();
  if (existing !== undefined) {
    deps.store.notify(remoteNotice(existing));
    return;
  }
  if (deps.remoteAuth === undefined) {
    notify(deps, "当前环境未配置账号登录，无法开启远程连接。", "warning");
    return;
  }
  const authStatus = await deps.remoteAuth.status();
  deps.store.setAuthStatus(authStatus);
  if (!authStatus.signedIn) {
    notify(deps, "远程连接需要登录。请先运行 /login 登录，成功后再运行 /remote。", "warning");
    return;
  }
  let remote: RemoteHostHandle;
  try {
    remote = await deps.startRemoteHost();
  } catch (error) {
    if (error instanceof RemoteAuthRequiredError) {
      notify(deps, "登录已过期。请先运行 /login 重新登录，成功后再运行 /remote。", "warning");
      return;
    }
    throw error;
  }
  deps.store.notify(remoteNotice(remote));
}

function remoteNotice(remote: RemoteHostInfo): TuiNotification {
  const lines =
    remote.code === undefined
      ? ["已恢复持久远程连接。其他设备可以继续使用原连接码运行 answra remote attach。"]
      : [
          "远程连接已开启。请在其他设备运行 answra remote attach，并输入下面的连接码：",
          remote.code,
        ];
  return {
    key: REMOTE_NOTICE_KEY,
    text: [
      ...lines,
      `Key ID: ${remote.keyId}`,
      "连接码会持久保存，直到在 host 上撤销。",
      `撤销命令：answra remote key revoke ${remote.keyId}`,
    ].join("\n"),
    tone: "info",
    timeoutMs: REMOTE_NOTICE_TIMEOUT_MS,
  };
}

function notify(deps: TuiCommandDeps, text: string, tone: "info" | "success" | "warning"): void {
  deps.store.notify({ key: REMOTE_NOTICE_KEY, text, tone });
}

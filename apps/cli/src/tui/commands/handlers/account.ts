/** 账号类命令：login/logout/status；只执行，不判断运行状态。 */
import type { TuiCommandDeps } from "../ports";

const ACCOUNT_NOTICE_KEY = "account";

export async function handleLogin(_args: readonly string[], deps: TuiCommandDeps): Promise<void> {
  if (deps.remoteAuth === undefined) {
    notify(deps, "当前环境未配置账号登录。", "warning");
    return;
  }
  await deps.login();
}

export async function handleLogout(_args: readonly string[], deps: TuiCommandDeps): Promise<void> {
  if (deps.remoteAuth === undefined) {
    notify(deps, "当前环境未配置账号登录。", "warning");
    return;
  }
  const status = await deps.remoteAuth.logout();
  deps.store.setAuthStatus(status);
  notify(deps, "已退出登录。", "success");
}

export async function handleStatus(args: readonly string[], deps: TuiCommandDeps): Promise<void> {
  if (args.length > 0) {
    notify(deps, "/status 不接受参数。", "warning");
    return;
  }
  if (deps.remoteAuth === undefined) {
    notify(deps, "当前环境未配置账号登录。", "warning");
    return;
  }
  const status = await deps.remoteAuth.status();
  deps.store.setAuthStatus(status);
  deps.openPanel("status");
}

function notify(deps: TuiCommandDeps, text: string, tone: "info" | "success" | "warning"): void {
  deps.store.notify({ key: ACCOUNT_NOTICE_KEY, text, tone });
}

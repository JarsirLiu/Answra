/** TUI 本地命令分派：唯一执行边界；先判 access，再按 catalog kind 调用 handler。 */
import { accessDenial } from "./access";
import type { TuiCommandKind } from "./catalog";
import { handleLogin, handleLogout, handleStatus } from "./handlers/account";
import { handleExit, handleHelp } from "./handlers/meta";
import { handleConfig, handleModel } from "./handlers/model";
import { handleRemote } from "./handlers/remote";
import {
  handleClear,
  handleCompact,
  handleDelete,
  handleNew,
  handleResume,
  handleSessions,
} from "./handlers/session";
import { handleSkills } from "./handlers/skill";
import type { TuiCommandInvocation } from "./parse";
import type { TuiCommandDeps, TuiCommandHandler } from "./ports";

const handlers = {
  help: handleHelp,
  clear: handleClear,
  new: handleNew,
  sessions: handleSessions,
  skills: handleSkills,
  resume: handleResume,
  delete: handleDelete,
  compact: handleCompact,
  config: handleConfig,
  exit: handleExit,
  model: handleModel,
  login: handleLogin,
  logout: handleLogout,
  status: handleStatus,
  remote: handleRemote,
} satisfies Record<TuiCommandKind, TuiCommandHandler>;

export async function dispatchTuiCommand(
  invocation: TuiCommandInvocation,
  deps: TuiCommandDeps,
): Promise<void> {
  if (invocation.command === undefined) {
    deps.store.notify({
      key: "command",
      text: `未知命令：/${invocation.name}\n输入 /help 查看可用命令。`,
      tone: "warning",
    });
    return;
  }
  const denial = accessDenial(invocation.command.access, deps.runtime());
  if (denial !== undefined) {
    deps.store.notify({ key: "access", text: denial, tone: "warning" });
    return;
  }
  try {
    await handlers[invocation.command.kind](invocation.args, deps);
  } catch (error) {
    deps.store.notify({ key: "command-error", text: messageOf(error), tone: "error" });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

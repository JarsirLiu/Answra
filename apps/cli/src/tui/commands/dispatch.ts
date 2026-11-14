/** TUI 本地命令分派：按 catalog kind 注册 handler；不承载会话队列或 Agent 运行时。 */
import type { ConversationModelConfig } from "@answra/shared";
import type { ModelSettings } from "../../model/ports";
import type { RemoteAuthPort } from "../../remote/auth/remoteAuthService";
import type { CodingSession } from "../../session/codingSession";
import type { TuiViewStore } from "../app/viewStore";
import type { TuiPanel } from "../panel";
import type { TuiCommandKind } from "./catalog";
import { TUI_HELP_LINES } from "./help";
import { handleModelCommand } from "./modelCommand";
import type { TuiCommandInvocation } from "./parse";

export interface TuiCommandDeps {
  readonly store: TuiViewStore;
  readonly modelSettings: ModelSettings;
  readonly isBusy: () => boolean;
  readonly getSession: () => CodingSession | undefined;
  readonly compactConversation: () => Promise<{ compacted: boolean; failed: boolean }>;
  readonly configureSession: (model: ConversationModelConfig) => Promise<void>;
  readonly requestExit: () => void;
  readonly openPanel: (panel: TuiPanel) => void;
  readonly remoteAuth?: RemoteAuthPort;
  readonly login: () => Promise<void>;
}

type TuiCommandHandler = (args: readonly string[], deps: TuiCommandDeps) => void | Promise<void>;

const handlers = {
  help: handleHelp,
  clear: handleClear,
  compact: handleCompact,
  config: handleConfig,
  exit: handleExit,
  model: handleModel,
  login: handleLogin,
  logout: handleLogout,
  status: handleStatus,
} satisfies Record<TuiCommandKind, TuiCommandHandler>;

export async function dispatchTuiCommand(
  invocation: TuiCommandInvocation,
  deps: TuiCommandDeps,
): Promise<void> {
  if (invocation.command === undefined) {
    deps.store.setNotice([`未知命令：/${invocation.name}`, "输入 /help 查看可用命令。"]);
    return;
  }
  try {
    await handlers[invocation.command.kind](invocation.args, deps);
  } catch (error) {
    deps.store.fail(messageOf(error));
  }
}

function handleHelp(_args: readonly string[], deps: TuiCommandDeps): void {
  deps.store.setNotice(TUI_HELP_LINES);
}

function handleConfig(args: readonly string[], deps: TuiCommandDeps): void {
  if (args.length > 0) {
    deps.store.setNotice(["/config 不接受参数。"]);
    return;
  }
  if (deps.isBusy()) {
    deps.store.setNotice(["当前运行中，先按 Esc 中断后再修改模型配置。"]);
    return;
  }
  deps.openPanel("config");
}

function handleExit(_args: readonly string[], deps: TuiCommandDeps): void {
  if (deps.isBusy()) {
    deps.store.setNotice(["当前运行中，先按 Esc 中断后再退出。"]);
    return;
  }
  deps.requestExit();
}

async function handleClear(_args: readonly string[], deps: TuiCommandDeps): Promise<void> {
  if (deps.isBusy()) {
    deps.store.setNotice(["当前运行中，先按 Esc 中断后再清除会话。"]);
    return;
  }
  const session = deps.getSession();
  if (session === undefined) throw new Error("尚未配置模型。");
  deps.store.reset(await session.clear());
  deps.store.setNotice(["会话已清除。"]);
}

async function handleCompact(args: readonly string[], deps: TuiCommandDeps): Promise<void> {
  if (args.length > 0) {
    deps.store.setNotice(["/compact 不接受参数。"]);
    return;
  }
  if (deps.isBusy()) {
    deps.store.setNotice(["当前运行中，先按 Esc 中断后再压缩会话。"]);
    return;
  }
  const result = await deps.compactConversation();
  if (!result.compacted && !result.failed) {
    deps.store.setNotice(["没有足够的旧消息可压缩。"]);
    return;
  }
  deps.store.setNotice(undefined);
}

async function handleModel(args: readonly string[], deps: TuiCommandDeps): Promise<void> {
  const session = deps.getSession();
  await handleModelCommand(args, {
    busy: deps.isBusy(),
    ...(session === undefined ? {} : { session }),
    configureSession: deps.configureSession,
    openPanel: deps.openPanel,
    store: deps.store,
    modelSettings: deps.modelSettings,
  });
}

async function handleLogin(_args: readonly string[], deps: TuiCommandDeps): Promise<void> {
  if (deps.remoteAuth === undefined) {
    deps.store.setNotice(["当前环境未配置账号登录。"]);
    return;
  }
  await deps.login();
}

async function handleLogout(_args: readonly string[], deps: TuiCommandDeps): Promise<void> {
  if (deps.remoteAuth === undefined) {
    deps.store.setNotice(["当前环境未配置账号登录。"]);
    return;
  }
  const status = await deps.remoteAuth.logout();
  deps.store.setAuthStatus(status);
  deps.store.setNotice(["已退出登录。"]);
}

async function handleStatus(args: readonly string[], deps: TuiCommandDeps): Promise<void> {
  if (args.length > 0) {
    deps.store.setNotice(["/status 不接受参数。"]);
    return;
  }
  if (deps.remoteAuth === undefined) {
    deps.store.setNotice(["当前环境未配置账号登录。"]);
    return;
  }
  const status = await deps.remoteAuth.status();
  deps.store.setAuthStatus(status);
  deps.openPanel("status");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

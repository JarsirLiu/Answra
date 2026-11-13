/** TUI 本地命令分派：按 catalog kind 注册 handler；不承载会话队列或 Agent 运行时。 */
import type { ConversationModelConfig } from "@answra/shared";
import type { ModelSettings } from "../../model/ports";
import type { CodingSession } from "../../session/codingSession";
import type { TuiViewStore } from "../app/viewStore";
import type { TuiCommandKind } from "./catalog";
import { TUI_HELP_LINES } from "./help";
import { handleModelCommand } from "./modelCommand";
import type { TuiCommandInvocation } from "./parse";

export interface TuiCommandDeps {
  readonly store: TuiViewStore;
  readonly modelSettings: ModelSettings;
  readonly isBusy: () => boolean;
  readonly getSession: () => CodingSession | undefined;
  readonly configureSession: (model: ConversationModelConfig) => Promise<void>;
  readonly requestExit: () => void;
}

type TuiCommandHandler = (args: readonly string[], deps: TuiCommandDeps) => void | Promise<void>;

const handlers = {
  help: handleHelp,
  clear: handleClear,
  exit: handleExit,
  model: handleModel,
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

async function handleModel(args: readonly string[], deps: TuiCommandDeps): Promise<void> {
  const session = deps.getSession();
  await handleModelCommand(args, {
    busy: deps.isBusy(),
    ...(session === undefined ? {} : { session }),
    configureSession: deps.configureSession,
    store: deps.store,
    modelSettings: deps.modelSettings,
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

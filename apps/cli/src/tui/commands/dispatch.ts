/** TUI 本地命令分派：按 catalog kind 注册 handler；不承载会话队列或 Agent 运行时。 */
import type {
  ConversationModelConfig,
  ConversationSessionSummary,
  ManualCompactionResult,
} from "@answra/shared";
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
  readonly compactConversation: (instructions?: string) => Promise<ManualCompactionResult>;
  readonly configureSession: (model: ConversationModelConfig) => Promise<void>;
  readonly requestExit: () => void;
  readonly openPanel: (panel: TuiPanel) => void;
  readonly remoteAuth?: RemoteAuthPort;
  readonly login: () => Promise<void>;
  readonly startRemoteHost?: () => Promise<{
    readonly code?: string;
    readonly keyId: string;
    readonly done: Promise<void>;
    stop(): Promise<void>;
  }>;
}

type TuiCommandHandler = (args: readonly string[], deps: TuiCommandDeps) => void | Promise<void>;

const handlers = {
  help: handleHelp,
  clear: handleClear,
  new: handleNew,
  sessions: handleSessions,
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

async function handleNew(args: readonly string[], deps: TuiCommandDeps): Promise<void> {
  if (args.length > 0) {
    deps.store.setNotice(["/new 不接受参数。"]);
    return;
  }
  if (deps.isBusy()) {
    deps.store.setNotice(["当前运行中，先按 Esc 中断后再新建会话。"]);
    return;
  }
  const session = deps.getSession();
  if (session === undefined) throw new Error("尚未配置模型。");
  deps.store.reset(await session.startNewConversation());
  deps.store.setNotice(["已新建会话。"]);
}

async function handleSessions(args: readonly string[], deps: TuiCommandDeps): Promise<void> {
  if (args.length > 0) {
    deps.store.setNotice(["/sessions 不接受参数。"]);
    return;
  }
  const session = deps.getSession();
  if (session === undefined) throw new Error("尚未配置模型。");
  const sessions = await session.listSessions();
  if (sessions.length === 0) {
    deps.store.setNotice(["当前 workspace 还没有历史会话。"]);
    return;
  }
  deps.store.setNotice([
    "历史会话：",
    ...sessions.map((item) =>
      sessionLine(item, item.conversationId === session.currentConversationId),
    ),
    "使用 /resume <ID 或唯一前缀> 继续；/delete <完整 ID> 删除。",
  ]);
}

async function handleResume(args: readonly string[], deps: TuiCommandDeps): Promise<void> {
  if (args.length !== 1) {
    deps.store.setNotice(["用法：/resume <ID 或唯一前缀>"]);
    return;
  }
  if (deps.isBusy()) {
    deps.store.setNotice(["当前运行中，先按 Esc 中断后再恢复会话。"]);
    return;
  }
  const session = deps.getSession();
  if (session === undefined) throw new Error("尚未配置模型。");
  const query = args[0] ?? "";
  const sessions = await session.listSessions();
  const exact = sessions.find((item) => item.conversationId === query);
  const matches = exact
    ? [exact]
    : sessions.filter((item) => item.conversationId.startsWith(query));
  if (matches.length === 0) {
    deps.store.setNotice([`没有匹配的会话：${query}`]);
    return;
  }
  if (matches.length > 1) {
    deps.store.setNotice([
      `会话前缀不唯一：${query}`,
      ...matches.slice(0, 5).map((item) => sessionLine(item, false)),
    ]);
    return;
  }
  const target = matches[0];
  if (target === undefined) return;
  deps.store.reset(await session.resume(target.conversationId));
  deps.store.setNotice([`已恢复会话：${target.conversationId}`]);
}

async function handleDelete(args: readonly string[], deps: TuiCommandDeps): Promise<void> {
  if (args.length !== 1) {
    deps.store.setNotice(["用法：/delete <完整会话 ID>"]);
    return;
  }
  if (deps.isBusy()) {
    deps.store.setNotice(["当前运行中，先按 Esc 中断后再删除会话。"]);
    return;
  }
  const session = deps.getSession();
  if (session === undefined) throw new Error("尚未配置模型。");
  const conversationId = args[0] ?? "";
  const sessions = await session.listSessions();
  if (!sessions.some((item) => item.conversationId === conversationId)) {
    deps.store.setNotice([`没有匹配的会话：${conversationId}`]);
    return;
  }
  const next = await session.deleteSession(conversationId);
  if (next !== undefined) deps.store.reset(next);
  deps.store.setNotice([
    next === undefined ? `已删除会话：${conversationId}` : "已删除当前会话并新建会话。",
  ]);
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
  if (deps.isBusy()) {
    deps.store.setNotice(["当前运行中，先按 Esc 中断后再压缩会话。"]);
    return;
  }
  const instructions = args.join(" ").trim();
  const result = await deps.compactConversation(instructions || undefined);
  if (result.status === "skipped") {
    deps.store.setNotice([
      result.reason === "insufficient-messages"
        ? "没有足够的旧消息可压缩。"
        : "当前没有可压缩的上下文。",
    ]);
    return;
  }
  if (result.status === "aborted") {
    deps.store.setNotice(["已取消压缩。"]);
    return;
  }
  if (result.status === "failed") {
    deps.store.fail(result.errorText ?? "上下文压缩失败。");
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

async function handleRemote(args: readonly string[], deps: TuiCommandDeps): Promise<void> {
  if (args.length > 0) {
    deps.store.setNotice(["/remote 不接受参数。"]);
    return;
  }
  if (deps.startRemoteHost === undefined) {
    deps.store.setNotice(["当前环境未配置远程连接。"]);
    return;
  }
  if (deps.isBusy()) {
    deps.store.setNotice(["当前运行中，先按 Esc 中断后再开启远程连接。"]);
    return;
  }
  const remote = await deps.startRemoteHost();
  deps.store.setNotice([
    remote.code === undefined
      ? "已恢复持久远程连接。其他设备可以继续使用原连接码运行 answra remote attach。"
      : "远程连接已开启。请在其他设备运行 answra remote attach，并输入下面的连接码：",
    ...(remote.code === undefined ? [] : [remote.code]),
    `Key ID: ${remote.keyId}`,
    "连接码会持久保存，直到在 host 上撤销。",
    `撤销命令：answra remote key revoke ${remote.keyId}`,
  ]);
}

function sessionLine(item: ConversationSessionSummary, active: boolean): string {
  const stamp = item.updatedAt.slice(0, 16).replace("T", " ");
  return `${item.conversationId}  ${stamp}  ${item.title}${active ? "  [当前]" : ""}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

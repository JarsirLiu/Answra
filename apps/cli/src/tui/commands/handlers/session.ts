/** 会话类命令：new/clear/sessions/resume/delete/compact；只执行，不判断运行状态。 */
import type { ConversationSessionSummary } from "@answra/shared";
import type { TuiCommandDeps } from "../ports";

const SESSION_NOTICE_KEY = "session";
const COMPACTION_NOTICE_KEY = "compaction";
const SESSION_LOOKUP_LIMIT = 200;
export async function handleNew(args: readonly string[], deps: TuiCommandDeps): Promise<void> {
  if (args.length > 0) {
    notify(deps, SESSION_NOTICE_KEY, "/new 不接受参数。", "warning");
    return;
  }
  if (deps.getSession() === undefined) throw new Error("尚未配置模型。");
  await deps.createNewSession();
  notify(deps, SESSION_NOTICE_KEY, "已新建会话。", "success");
}

export function handleSessions(args: readonly string[], deps: TuiCommandDeps): void {
  if (args.length > 0) {
    notify(deps, SESSION_NOTICE_KEY, "/sessions 不接受参数。", "warning");
    return;
  }
  if (deps.getSession() === undefined) throw new Error("尚未配置模型。");
  // 列表放进可滚动的面板：通知会被输入框挤出视口，无法翻看长列表。
  deps.openPanel("sessions");
}

export async function handleResume(args: readonly string[], deps: TuiCommandDeps): Promise<void> {
  if (args.length !== 1) {
    notify(deps, SESSION_NOTICE_KEY, "用法：/resume <ID 或唯一前缀>", "warning");
    return;
  }
  const session = deps.getSession();
  if (session === undefined) throw new Error("尚未配置模型。");
  const query = args[0] ?? "";
  const sessions = (await session.listSessions({ limit: SESSION_LOOKUP_LIMIT })).items;
  const exact = sessions.find((item) => item.conversationId === query);
  const matches = exact
    ? [exact]
    : sessions.filter((item) => item.conversationId.startsWith(query));
  if (matches.length === 0) {
    notify(deps, SESSION_NOTICE_KEY, `没有匹配的会话：${query}`, "warning");
    return;
  }
  if (matches.length > 1) {
    notify(
      deps,
      SESSION_NOTICE_KEY,
      [
        `会话前缀不唯一：${query}`,
        ...matches.slice(0, 5).map((item) => sessionLine(item, false)),
      ].join("\n"),
      "warning",
    );
    return;
  }
  const target = matches[0];
  if (target === undefined) return;
  await deps.activateSession(target.conversationId);
  notify(deps, SESSION_NOTICE_KEY, `已恢复会话：${target.conversationId}`, "success");
}

export async function handleDelete(args: readonly string[], deps: TuiCommandDeps): Promise<void> {
  if (args.length !== 1) {
    notify(deps, SESSION_NOTICE_KEY, "用法：/delete <完整会话 ID>", "warning");
    return;
  }
  const session = deps.getSession();
  if (session === undefined) throw new Error("尚未配置模型。");
  const conversationId = args[0] ?? "";
  const sessions = (await session.listSessions({ limit: SESSION_LOOKUP_LIMIT })).items;
  if (!sessions.some((item) => item.conversationId === conversationId)) {
    notify(deps, SESSION_NOTICE_KEY, `没有匹配的会话：${conversationId}`, "warning");
    return;
  }
  const next = await deps.deleteSession(conversationId);
  if (next !== undefined) deps.store.reset(next);
  notify(
    deps,
    SESSION_NOTICE_KEY,
    next === undefined ? `已删除会话：${conversationId}` : "已删除当前会话并新建会话。",
    "success",
  );
}

export async function handleClear(_args: readonly string[], deps: TuiCommandDeps): Promise<void> {
  const session = deps.getSession();
  if (session === undefined) throw new Error("尚未配置模型。");
  deps.store.reset(await session.clear());
  notify(deps, SESSION_NOTICE_KEY, "会话已清除。", "success");
}

export async function handleCompact(args: readonly string[], deps: TuiCommandDeps): Promise<void> {
  const instructions = args.join(" ").trim();
  const result = await deps.compactConversation(instructions || undefined);
  if (result.status === "skipped") {
    notify(
      deps,
      COMPACTION_NOTICE_KEY,
      result.reason === "insufficient-messages"
        ? "没有足够的旧消息可压缩。"
        : "当前没有可压缩的上下文。",
      "info",
    );
    return;
  }
  if (result.status === "aborted") {
    notify(deps, COMPACTION_NOTICE_KEY, "已取消压缩。", "info");
    return;
  }
  if (result.status === "failed") {
    deps.store.fail(result.errorText ?? "上下文压缩失败。");
  }
}

function notify(
  deps: TuiCommandDeps,
  key: string,
  text: string,
  tone: "info" | "success" | "warning",
): void {
  deps.store.notify({ key, text, tone });
}

function sessionLine(item: ConversationSessionSummary, active: boolean): string {
  const stamp = item.updatedAt.slice(0, 16).replace("T", " ");
  return `${item.conversationId}  ${stamp}  ${item.title}${active ? "  [当前]" : ""}`;
}

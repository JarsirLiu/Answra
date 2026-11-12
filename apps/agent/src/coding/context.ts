/** CLI coding 的模型上下文：transcript 投影 + 工作区/运行环境事实，不依赖 conversation 领域。 */
import os from "node:os";
import type { ConversationSendRequest } from "@answra/shared";
import type { ModelMessage } from "ai";
import { resolveShellRuntime } from "../core/tool";
import { projectConversationMessages } from "../core/transcript/projection";
import type { ConversationStore } from "../core/transcript/store";

export async function buildCodingMessages({
  conversationId,
  request,
  includeHistory,
  store,
}: {
  conversationId: string;
  request: ConversationSendRequest;
  includeHistory: boolean;
  store: ConversationStore;
}): Promise<ModelMessage[]> {
  if (!includeHistory) return [userMessage(request)];
  const snapshot = await store.load(conversationId);
  return projectConversationMessages({ messages: snapshot.messages });
}

function userMessage(request: ConversationSendRequest): ModelMessage {
  return { role: "user", content: [{ type: "text", text: request.text }] };
}

const PLATFORM_LABELS: Partial<Record<NodeJS.Platform, string>> = {
  win32: "Windows",
  darwin: "macOS",
  linux: "Linux",
};

export function buildCodingWorkspaceContext(workspaceRoot: string | null): string {
  if (!workspaceRoot) {
    return ["# 工作区", "没有可用的工作区根目录；相对路径不可解析，必须使用绝对路径。"].join("\n");
  }
  return [
    "# 工作区",
    `当前工作目录：${workspaceRoot}`,
    "相对路径以该目录为基线；工作区不是访问边界，用户明确指向其他目录时可以使用绝对路径。",
    "目录中存在 AGENTS.md 时，先阅读并遵守其中的约定。",
  ].join("\n");
}

export function buildCodingEnvironmentContext(): string {
  const shell = resolveShellRuntime();
  const platform = PLATFORM_LABELS[process.platform] ?? process.platform;
  const syntax =
    shell.syntax === "powershell"
      ? "使用 PowerShell 语法；不要使用 bash/sh 专有语法，路径按 Windows 规则书写。"
      : "使用 POSIX shell 语法。";
  return [
    "# 运行环境",
    `- 操作系统：${platform}（${process.platform} ${os.release()} ${os.arch()}）`,
    `- Shell：${shell.displayName}`,
    `- 命令语法：${syntax}`,
  ].join("\n");
}

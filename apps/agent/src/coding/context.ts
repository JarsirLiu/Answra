/** CLI coding 的模型上下文：transcript 投影 + 工作区/运行环境事实，不依赖 conversation 领域。 */
import os from "node:os";
import type { ConversationSendRequest } from "@answra/shared";
import type { ModelMessage } from "ai";
import { projectContextMessages } from "../core/context/projection";
import { parseDataUrl } from "../core/model/imageInput";
import { describeShellSyntax, resolveShellRuntime } from "../core/tool";
import { latestCheckpoint } from "../core/transcript/contextCheckpoint";
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
  return projectContextMessages({
    messages: snapshot.messages,
    checkpoint: latestCheckpoint(await store.loadContextState(conversationId)),
    project: (tail) =>
      projectConversationMessages({
        messages: tail,
        ...(snapshot.activeMessageId === undefined
          ? {}
          : { activeMessageId: snapshot.activeMessageId }),
      }),
  });
}

function userMessage(request: ConversationSendRequest): ModelMessage {
  return {
    role: "user",
    content: [
      ...(request.text ? [{ type: "text" as const, text: request.text }] : []),
      ...request.images.map((image) => {
        const parsed = parseDataUrl(image.dataUrl);
        return {
          type: "image" as const,
          image: parsed.bytes,
          mediaType: parsed.mediaType,
        };
      }),
    ],
  };
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
    "AGENTS.md 会自动加入上下文；若上下文中没有对应内容，可按需读取工作区文件确认。",
  ].join("\n");
}

export function buildCodingEnvironmentContext(): string {
  const shell = resolveShellRuntime();
  const platform = PLATFORM_LABELS[process.platform] ?? process.platform;
  return [
    "# 运行环境",
    `- 操作系统：${platform}（${process.platform} ${os.release()} ${os.arch()}）。`,
    `- Shell：${shell.displayName}`,
    `- 命令语法：${describeShellSyntax(shell)}`,
  ].join("\n");
}

import {
  authRequiredError,
  ConversationChannels,
  type ConversationModelSettingsView,
  type ConversationSendCommand,
} from "@answra/shared";
import { ipcMain } from "electron";
import {
  getWindow,
  isReplyBarConversationId,
  isReplyBarWindowFromSender,
  isWindowFromSender,
  sendConversationChange,
} from "../window";
import type { AgentService } from "./agentService";

/** 模型设置侧的只读/写入面，由 `ModelRouter` 实现。 */
export interface ConversationModelSettingsPort {
  getView(): ConversationModelSettingsView;
  save(input: unknown): Promise<ConversationModelSettingsView>;
  clear(): Promise<ConversationModelSettingsView>;
  revealApiKey(): Promise<string | null>;
}

export interface ConversationIpcDeps {
  /** 发送门禁：本地来源直接放行，云端来源需要登录态。 */
  canSend: () => boolean;
  modelSettings: ConversationModelSettingsPort;
}

/**
 * @param canSend 是否允许发起模型调用（本地来源或已登录）。
 * @param modelSettings 模型来源与本地端点的读写面。
 */
export function registerConversationIpc(service: AgentService, deps: ConversationIpcDeps): void {
  ipcMain.handle(ConversationChannels.Send, (event, payload: ConversationSendCommand) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用方");
    if (payload?.operation === "chat.send" && payload.profileId !== "general-chat")
      throw new Error("对话能力配置无效");
    if (payload?.operation !== "chat.send" && payload?.operation !== "answer.run")
      throw new Error("AI 操作类型无效");
    // 云端来源需要登录：未登录返回统一失败码，由渲染层提示登录。
    // 本地来源不需要登录，未配置时由 service 给出配置提示。
    if (!deps.canSend()) throw authRequiredError();
    return service.send(payload);
  });
  ipcMain.handle(
    ConversationChannels.AppendUserMessage,
    (event, payload: { conversationId: string; text: string }) => {
      if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用方");
      if (
        payload?.conversationId !== "active-interview-conversation" ||
        typeof payload.text !== "string" ||
        !payload.text.trim() ||
        payload.text.length > 32_000
      )
        throw new Error("面试消息无效");
      return service.appendUserMessage(payload.conversationId, payload.text);
    },
  );
  ipcMain.handle(ConversationChannels.GetSnapshot, (event, payload: { conversationId: string }) => {
    if (!isValidConversationId(payload?.conversationId)) throw new Error("会话请求无效");
    if (!isConversationReadSender(event, payload.conversationId)) throw new Error("非法调用方");
    return service.getSnapshot(payload.conversationId);
  });
  ipcMain.handle(ConversationChannels.Create, (event, payload: { conversationId: string }) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用方");
    return service.createConversation(payload.conversationId);
  });
  ipcMain.handle(
    ConversationChannels.ReadEvents,
    (event, payload: { conversationId: string; afterRevision: number }) => {
      if (
        !isValidConversationId(payload?.conversationId) ||
        !Number.isSafeInteger(payload?.afterRevision) ||
        payload.afterRevision < 0
      )
        throw new Error("会话请求无效");
      if (!isConversationReadSender(event, payload.conversationId)) throw new Error("非法调用方");
      return service.readEvents(payload.conversationId, payload.afterRevision);
    },
  );
  ipcMain.on(ConversationChannels.Cancel, (event, payload: { runId: string }) => {
    if (!isWindowFromSender(getWindow(), event) || typeof payload?.runId !== "string") return;
    service.cancel(payload.runId);
  });
  ipcMain.handle(ConversationChannels.GetConfig, async (event) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用方");
    return deps.modelSettings.getView();
  });
  ipcMain.handle(ConversationChannels.Configure, (event, settings: unknown) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用方");
    return deps.modelSettings.save(settings);
  });
  ipcMain.handle(ConversationChannels.GetApiKey, async (event) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用方");
    return { apiKey: await deps.modelSettings.revealApiKey() };
  });
  ipcMain.handle(ConversationChannels.ClearConfig, (event) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用方");
    return deps.modelSettings.clear();
  });
  service.onChange(sendConversationChange);
}

function isValidConversationId(conversationId: unknown): conversationId is string {
  return (
    typeof conversationId === "string" && conversationId.length > 0 && conversationId.length <= 128
  );
}

function isConversationReadSender(
  event: Parameters<typeof isWindowFromSender>[1],
  conversationId: string | undefined,
): boolean {
  return (
    isWindowFromSender(getWindow(), event) ||
    (conversationId !== undefined &&
      isReplyBarConversationId(conversationId) &&
      isReplyBarWindowFromSender(event))
  );
}

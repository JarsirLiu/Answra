import {
  authRequiredError,
  ConversationChannels,
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

/**
 * @param isSignedIn 本机是否持有登录会话；模型调用是与云端能力绑定的入口，未登录直接
 *   以统一的失败码拒绝，渲染层据此提示登录。
 */
export function registerConversationIpc(
  service: AgentService,
  isSignedIn: () => boolean = () => true,
): void {
  ipcMain.handle(ConversationChannels.Send, (event, payload: ConversationSendCommand) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用方");
    if (payload?.operation === "chat.send" && payload.profileId !== "general-chat")
      throw new Error("对话能力配置无效");
    if (payload?.operation !== "chat.send" && payload?.operation !== "answer.run")
      throw new Error("AI 操作类型无效");
    // 调用模型是需要登录的能力：未登录返回统一失败码，由渲染层提示登录。
    // 真实授权始终由服务端强制，这里只把「未登录」变成可识别的信号，不做预门禁。
    if (!isSignedIn()) throw authRequiredError();
    return service.send(payload);
  });
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

import {
  ConversationChannels,
  type ConversationSessionScope,
  type ConversationSessionSummary,
} from "@answra/shared";
import { ipcMain } from "electron";
import type { AgentService } from "../agent/agentService";
import { getWindow, isWindowFromSender } from "../window";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** 会话历史 IPC：只暴露 conversation scope，避免 renderer 删除 coding/answer/interview。 */
export function registerConversationSessionIpc(service: AgentService): void {
  ipcMain.handle(
    ConversationChannels.ListSessions,
    (event, payload: { scope?: ConversationSessionScope } | undefined) => {
      if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用");
      if (payload?.scope !== undefined && payload.scope !== "conversation") {
        throw new Error("会话 scope 无效");
      }
      return service.listConversationSessions({ scope: "conversation" });
    },
  );

  ipcMain.handle(
    ConversationChannels.DeleteSession,
    async (event, payload: { conversationId: string }) => {
      if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用");
      const conversationId = payload?.conversationId;
      if (typeof conversationId !== "string" || !SESSION_ID_PATTERN.test(conversationId)) {
        throw new Error("会话请求无效");
      }
      const sessions: readonly ConversationSessionSummary[] =
        await service.listConversationSessions({ scope: "conversation" });
      if (!sessions.some((session) => session.conversationId === conversationId)) {
        throw new Error("会话不存在或不属于当前 scope");
      }
      await service.deleteConversationSession(conversationId);
    },
  );
}

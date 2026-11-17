import { ConversationChannels, type ConversationSessionScope } from "@answra/shared";
import { ipcMain } from "electron";
import type { AgentService } from "../agent/agentService";
import { getWindow, isWindowFromSender } from "../window";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SESSION_PAGE_SIZE = 200;

/** 会话历史 IPC：只暴露 conversation scope，避免 renderer 删除 coding/answer/interview。 */
export function registerConversationSessionIpc(service: AgentService): void {
  ipcMain.handle(
    ConversationChannels.ListSessions,
    (
      event,
      payload: { scope?: ConversationSessionScope; cursor?: string; limit?: number } | undefined,
    ) => {
      if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用");
      if (payload?.scope !== undefined && payload.scope !== "conversation") {
        throw new Error("会话 scope 无效");
      }
      if (payload?.cursor !== undefined && typeof payload.cursor !== "string") {
        throw new Error("会话游标无效");
      }
      if (
        payload?.limit !== undefined &&
        (!Number.isInteger(payload.limit) ||
          payload.limit < 1 ||
          payload.limit > MAX_SESSION_PAGE_SIZE)
      ) {
        throw new Error("会话分页大小无效");
      }
      return service.listConversationSessions({
        scope: "conversation",
        ...(payload?.cursor === undefined ? {} : { cursor: payload.cursor }),
        ...(payload?.limit === undefined ? {} : { limit: payload.limit }),
      });
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
      if (!(await hasConversationSession(service, conversationId))) {
        throw new Error("会话不存在或不属于当前 scope");
      }
      await service.deleteConversationSession(conversationId);
    },
  );
}

async function hasConversationSession(
  service: AgentService,
  conversationId: string,
): Promise<boolean> {
  let cursor: string | undefined;
  for (;;) {
    const page = await service.listConversationSessions({
      scope: "conversation",
      limit: MAX_SESSION_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (page.items.some((session) => session.conversationId === conversationId)) return true;
    if (page.nextCursor === undefined) return false;
    cursor = page.nextCursor;
  }
}

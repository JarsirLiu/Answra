/** 把 @answra/agent/composition 的 CodingHost 适配为 CLI 会话端口。 */
import type { CodingHost } from "@answra/agent/composition";
import type { CodingSessionHost } from "../session/codingSession";

export function createAgentCodingSessionHost(host: CodingHost): CodingSessionHost {
  return {
    configure: (model) => host.runtime.configure(model),
    createConversation: (conversationId) => host.runtime.createConversation(conversationId),
    getSnapshot: (conversationId) => host.runtime.getSnapshot(conversationId),
    listSessions: async (query) => {
      if (!host.catalog) throw new Error("当前宿主不支持会话历史。");
      return host.catalog.list({
        scope: "coding",
        ...(query.workspaceRoot === undefined ? {} : { workspaceRoot: query.workspaceRoot }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
    },
    getSession: async (conversationId, workspaceRoot) => {
      if (!host.catalog) throw new Error("当前宿主不支持会话历史。");
      const session = await host.catalog.getSession(conversationId, workspaceRoot);
      return session?.scope === "coding" ? session : undefined;
    },
    deleteSession: async (conversationId) => {
      if (!host.catalog) throw new Error("当前宿主不支持会话历史。");
      return host.catalog.delete(conversationId);
    },
    clearConversation: (conversationId) => host.runtime.clearConversation(conversationId),
    compactConversation: (conversationId, accessToken, options) =>
      host.runtime.compactConversation(conversationId, accessToken, options),
    send: async (conversationId, request, accessToken) => {
      return host.runtime.send(conversationId, request, accessToken);
    },
    cancel: (runId) => host.runtime.cancel(runId),
    waitForRun: (runId) => host.runtime.waitForRun(runId),
    dispose: () => host.dispose(),
    shutdown: () => host.shutdown(),
  };
}

/** 把 @answra/agent/composition 的 CodingHost 适配为 CLI 会话端口。 */
import type { CodingHost } from "@answra/agent/composition";
import type { CodingSessionHost } from "../session/codingSession";

export function createAgentCodingSessionHost(host: CodingHost): CodingSessionHost {
  return {
    configure: (model) => host.runtime.configure(model),
    createConversation: (conversationId, accessToken) =>
      host.runtime.createConversation(conversationId, accessToken),
    getSnapshot: (conversationId, accessToken) =>
      host.runtime.getSnapshot(conversationId, accessToken),
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
    listSkills: async () =>
      (await host.listSkills()).map(({ name, description, source, directory }) => ({
        name,
        description,
        source,
        directory,
      })),
    deleteSession: async (conversationId) => {
      if (!host.catalog) throw new Error("当前宿主不支持会话历史。");
      return host.catalog.delete(conversationId);
    },
    clearConversation: (conversationId, accessToken) =>
      host.runtime.clearConversation(conversationId, accessToken),
    compactConversation: (conversationId, accessToken, options) =>
      host.runtime.compactConversation(conversationId, accessToken, options),
    send: async (conversationId, request, accessToken) => {
      return host.runtime.send(conversationId, request, accessToken);
    },
    enqueue: (conversationId, request, accessToken) =>
      host.runtime.enqueue(conversationId, request, accessToken),
    waitForQueueStart: (conversationId, queueId) =>
      host.runtime.waitForQueueStart(conversationId, queueId),
    cancel: (conversationId, turnId) => host.runtime.cancel(conversationId, turnId),
    waitForTurn: (conversationId, turnId) => host.runtime.waitForTurn(conversationId, turnId),
    readFrames: (conversationId, afterSeq) =>
      host.runtime.readFramesAfter(conversationId, afterSeq),
    dispose: () => host.dispose(),
    shutdown: () => host.shutdown(),
  };
}

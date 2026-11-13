/** 把 @answra/agent/composition 的 CodingHost 适配为 CLI 会话端口。 */
import type { CodingHost } from "@answra/agent/composition";
import type { CodingSessionHost } from "../session/codingSession";

export function createAgentCodingSessionHost(host: CodingHost): CodingSessionHost {
  return {
    configure: (model) => host.runtime.configure(model),
    createConversation: (conversationId) => host.runtime.createConversation(conversationId),
    clearConversation: (conversationId) => host.runtime.clearConversation(conversationId),
    send: async (conversationId, request, accessToken) => {
      const { runId } = await host.runtime.send(conversationId, request, accessToken);
      return { runId };
    },
    cancel: (runId) => host.runtime.cancel(runId),
    waitForRun: (runId) => host.runtime.waitForRun(runId),
    dispose: () => host.dispose(),
  };
}

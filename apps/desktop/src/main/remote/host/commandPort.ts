/** 桌面 AgentService 到远程 HostCommandPort 的适配；只暴露 conversation scope，不承载传输。 */
import {
  type HostCommandPort,
  type HostModelSettingsPort,
  RemoteOperationError,
  remoteError,
} from "@answra/remote";
import type { RemoteCapability, RemoteSessionListQuery } from "@answra/shared/schema";
import type { DesktopRemoteAgentPort } from "./agentPort";

const CAPABILITIES: readonly RemoteCapability[] = ["conversation", "sessions"];

export function createDesktopRemoteCommandPort(agent: DesktopRemoteAgentPort): HostCommandPort {
  const visibleConversationIds = new Set<string>();

  const requireVisible = (conversationId: string): void => {
    if (!visibleConversationIds.has(conversationId)) {
      throw new RemoteOperationError(remoteError("not-found", "conversation is not available"));
    }
  };

  const unsupportedModelSettings = (): never => {
    throw new RemoteOperationError(
      remoteError("invalid-command", "model settings are unsupported"),
    );
  };

  const settings: HostModelSettingsPort = {
    snapshot: async () => unsupportedModelSettings(),
    addLocal: async () => unsupportedModelSettings(),
    switchChatModel: async () => unsupportedModelSettings(),
    clearLocal: async () => unsupportedModelSettings(),
  };

  return {
    capabilities: () => CAPABILITIES,
    async createConversation(conversationId, selection) {
      if (selection?.kind === "team") {
        throw new RemoteOperationError(
          remoteError("invalid-command", "team conversation is unsupported"),
        );
      }
      const snapshot = await agent.createConversation(conversationId, selection);
      visibleConversationIds.add(conversationId);
      return snapshot;
    },
    async clearConversation(conversationId) {
      requireVisible(conversationId);
      return agent.clearConversation(conversationId);
    },
    async snapshot(conversationId) {
      requireVisible(conversationId);
      return agent.getSnapshot(conversationId);
    },
    async readEvents(conversationId, afterRevision) {
      requireVisible(conversationId);
      return agent.readEvents(conversationId, afterRevision);
    },
    async listSessions(query?: RemoteSessionListQuery) {
      const page = await agent.listConversationSessions({
        scope: "conversation",
        ...(query?.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query?.limit === undefined ? {} : { limit: query.limit }),
      });
      for (const session of page.items) {
        visibleConversationIds.add(session.conversationId);
      }
      return page;
    },
    async send(command) {
      requireVisible(command.conversationId);
      if (command.operation !== "chat.send") {
        throw new RemoteOperationError(remoteError("invalid-command", "team send is unsupported"));
      }
      const response = await agent.send(command);
      if (!("status" in response)) {
        throw new RemoteOperationError(
          remoteError("internal", "conversation send did not return a queue result"),
        );
      }
      return response;
    },
    async waitQueue(conversationId, queueId) {
      requireVisible(conversationId);
      return agent.waitForConversationQueue(conversationId, queueId);
    },
    async waitQueueStart(conversationId, queueId) {
      requireVisible(conversationId);
      return agent.waitForConversationQueueStart(conversationId, queueId);
    },
    cancel(conversationId, runId) {
      requireVisible(conversationId);
      agent.cancel(runId);
    },
    applyModel: () => unsupportedModelSettings(),
    settings: () => settings,
    onSnapshot(listener) {
      return agent.onSnapshot((snapshot) => {
        if (!visibleConversationIds.has(snapshot.conversationId)) return;
        listener(snapshot);
      });
    },
    onEvent(listener) {
      return agent.onEvent((event) => {
        if (!visibleConversationIds.has(event.conversationId)) return;
        listener(event);
      });
    },
  };
}

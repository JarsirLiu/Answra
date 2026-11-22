/** 把 CLI coding host 的 CodingApplication 映射为远程 HostCommandPort。 */
import { startCodingHost } from "@answra/agent/composition";
import {
  type HostCommandPort,
  type HostModelSettingsPort,
  RemoteOperationError,
  remoteError,
} from "@answra/remote";
import type { ConversationModelConfig } from "@answra/shared";
import type {
  AgentEventEnvelope,
  ConversationSnapshot,
  RemoteCapability,
  RemoteModelConfig,
  RemoteModelSettingsView,
} from "@answra/shared/schema";
import { resolveCliInstructionFile } from "../../config/instructionFile";
import { resolveCliSkillRoots } from "../../config/skillRoots";
import type { ModelSettings } from "../../model/ports";

const CAPABILITIES: readonly RemoteCapability[] = ["coding", "model-settings"];

export interface RemoteCodingHostOptions {
  workspaceRoot: string;
  modelSettings: ModelSettings;
  accessToken: string;
}

export interface RemoteCodingHost {
  port: HostCommandPort;
  dispose(): void;
}

export function createRemoteCodingHost({
  workspaceRoot,
  modelSettings,
  accessToken,
}: RemoteCodingHostOptions): RemoteCodingHost {
  const snapshotListeners = new Set<(snapshot: ConversationSnapshot) => void>();
  const eventListeners = new Set<(event: AgentEventEnvelope) => void>();

  const coding = startCodingHost({
    emitEvent: (event) => {
      for (const listener of eventListeners) listener(event);
    },
    onSnapshot: (snapshot) => {
      for (const listener of snapshotListeners) listener(snapshot);
    },
    workspaceRoot,
    globalInstructionFile: resolveCliInstructionFile(),
    skillRoots: resolveCliSkillRoots(workspaceRoot),
  });

  const settings = createHostModelSettings(modelSettings);
  const port: HostCommandPort = {
    capabilities: () => CAPABILITIES,
    createConversation: (conversationId) =>
      coding.runtime.createConversation(conversationId, accessToken),
    clearConversation: (conversationId) =>
      coding.runtime.clearConversation(conversationId, accessToken),
    snapshot: (conversationId) => coding.runtime.getSnapshot(conversationId, accessToken),
    readEvents: (conversationId, afterRevision) =>
      coding.runtime.readEventsAfter(conversationId, afterRevision),
    async send(command) {
      if (command.operation !== "chat.send") {
        throw new RemoteOperationError(remoteError("invalid-command", "team send is unsupported"));
      }
      return coding.runtime.enqueue(command.conversationId, command.request, accessToken);
    },
    waitQueue: (conversationId, queueId) => coding.runtime.waitForQueue(conversationId, queueId),
    waitQueueStart: (conversationId, queueId) =>
      coding.runtime.waitForQueueStart(conversationId, queueId),
    cancel: (conversationId, turnId) => coding.runtime.cancel(conversationId, turnId),
    applyModel: (config) => coding.runtime.configure(toConversationModelConfig(config)),
    settings: () => settings,
    onSnapshot(listener) {
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  };

  return {
    port,
    dispose: () => coding.dispose(),
  };
}

function createHostModelSettings(modelSettings: ModelSettings): HostModelSettingsPort {
  return {
    snapshot: async () => toRemoteModelSettings(await modelSettings.snapshot()),
    async addLocal(input) {
      await modelSettings.addLocal(input);
      return toRemoteModelSettings(await modelSettings.snapshot());
    },
    async switchChatModel(chatModel) {
      await modelSettings.switchChatModel(chatModel);
      return toRemoteModelSettings(await modelSettings.snapshot());
    },
    async clearLocal() {
      await modelSettings.clearLocal();
      return toRemoteModelSettings(await modelSettings.snapshot());
    },
  };
}

function toRemoteModelSettings(
  snapshot: Awaited<ReturnType<ModelSettings["snapshot"]>>,
): RemoteModelSettingsView {
  const { local } = snapshot;
  return {
    source: snapshot.source,
    baseUrl: local.baseUrl,
    chatModel: local.chatModel,
    ...(local.answerModel === undefined ? {} : { answerModel: local.answerModel }),
    configured: snapshot.configured,
  };
}

function toConversationModelConfig(config: RemoteModelConfig): ConversationModelConfig {
  return {
    chat: {
      baseUrl: config.chat.baseUrl,
      model: config.chat.model,
      ...(config.chat.auth === undefined ? {} : { auth: config.chat.auth }),
    },
    answer: {
      baseUrl: config.answer.baseUrl,
      model: config.answer.model,
      ...(config.answer.auth === undefined ? {} : { auth: config.answer.auth }),
    },
  };
}

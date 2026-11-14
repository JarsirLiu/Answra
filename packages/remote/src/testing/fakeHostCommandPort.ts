import type {
  AgentEventEnvelope,
  BotSummary,
  ConversationSnapshot,
  RemoteCapability,
  RemoteLocalModelInput,
  RemoteModelConfig,
  RemoteModelSettingsView,
  RemoteSendCommand,
} from "@answra/shared/schema";
import type { HostCommandPort, HostModelSettingsPort } from "../host/hostPort";
import {
  createFakeAgentEvent,
  createFakeBotSummary,
  createFakeConversationSnapshot,
  createFakeModelSettingsView,
} from "./fixtures";

export interface FakeHostCommandPortOptions {
  capabilities?: readonly RemoteCapability[];
  snapshot?: ConversationSnapshot;
  modelSettings?: RemoteModelSettingsView;
  bots?: readonly BotSummary[];
}

export interface FakeHostCommandPort extends HostCommandPort {
  readonly sentCommands: RemoteSendCommand[];
  readonly cancelledRunIds: string[];
  readonly appliedModels: RemoteModelConfig[];
  emitEvent(event: AgentEventEnvelope): void;
  emitSnapshot(snapshot: ConversationSnapshot): void;
}

export function createFakeHostCommandPort(
  options: FakeHostCommandPortOptions = {},
): FakeHostCommandPort {
  const capabilities = options.capabilities ?? ["coding", "model-settings"];
  const bots = options.bots ?? [createFakeBotSummary()];
  const sentCommands: RemoteSendCommand[] = [];
  const cancelledRunIds: string[] = [];
  const appliedModels: RemoteModelConfig[] = [];
  const events: AgentEventEnvelope[] = [];
  const eventListeners = new Set<(event: AgentEventEnvelope) => void>();
  const snapshotListeners = new Set<(snapshot: ConversationSnapshot) => void>();
  let currentSnapshot = options.snapshot ?? createFakeConversationSnapshot();
  let currentModelSettings = options.modelSettings ?? createFakeModelSettingsView();
  let runSequence = 0;

  const settings: HostModelSettingsPort = {
    async snapshot() {
      return currentModelSettings;
    },
    async addLocal(input: RemoteLocalModelInput) {
      currentModelSettings = {
        source: "local",
        baseUrl: input.baseUrl,
        chatModel: input.chatModel,
        ...(input.answerModel === undefined ? {} : { answerModel: input.answerModel }),
        configured: true,
      };
      return currentModelSettings;
    },
    async switchChatModel(chatModel: string) {
      currentModelSettings = {
        ...currentModelSettings,
        source: "local",
        chatModel,
        configured: true,
      };
      return currentModelSettings;
    },
    async clearLocal() {
      currentModelSettings = {
        source: "cloud",
        baseUrl: "",
        chatModel: "",
        configured: false,
      };
      return currentModelSettings;
    },
  };

  return {
    sentCommands,
    cancelledRunIds,
    appliedModels,
    capabilities: () => capabilities,
    async createConversation(conversationId) {
      currentSnapshot = {
        conversationId,
        eventRevision: currentSnapshot.eventRevision,
        messages: [],
      };
      return currentSnapshot;
    },
    async clearConversation(conversationId) {
      currentSnapshot = {
        ...currentSnapshot,
        conversationId,
        messages: [],
      };
      return currentSnapshot;
    },
    async snapshot(conversationId) {
      return { ...currentSnapshot, conversationId };
    },
    async readEvents(_conversationId, afterRevision) {
      return events.filter((event) => event.aggregateRevision > afterRevision);
    },
    async send(command) {
      sentCommands.push(command);
      runSequence += 1;
      return {
        queueId: `queue-${runSequence}`,
        status: "started",
        position: 0,
        runId: `run-${runSequence}`,
        snapshot: currentSnapshot,
      };
    },
    async waitQueue(_conversationId, queueId) {
      return { queueId, runId: `run-${runSequence}`, outcome: "completed" };
    },
    async waitQueueStart(_conversationId, queueId) {
      return { queueId, runId: `run-${runSequence}`, snapshot: currentSnapshot };
    },
    cancel(runId) {
      cancelledRunIds.push(runId);
    },
    async listBots() {
      return [...bots];
    },
    async selectBot() {},
    applyModel(config) {
      appliedModels.push(config);
    },
    settings: () => settings,
    onSnapshot(listener) {
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    emitEvent(event) {
      events.push(event);
      for (const listener of eventListeners) listener(event);
    },
    emitSnapshot(snapshot) {
      currentSnapshot = snapshot;
      for (const listener of snapshotListeners) listener(snapshot);
    },
  };
}

export function createFakeAgentEventForConversation(
  conversationId: string,
  sequence = 1,
): AgentEventEnvelope {
  return {
    ...createFakeAgentEvent(sequence),
    conversationId,
  };
}

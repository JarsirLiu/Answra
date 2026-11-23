import type {
  BotSummary,
  ConversationSessionPage,
  ConversationSnapshot,
  LiveFrame,
  RemoteCapability,
  RemoteLocalModelInput,
  RemoteModelConfig,
  RemoteModelSettingsView,
  RemoteSendCommand,
  SessionFrame,
} from "@answra/shared/schema";
import type { HostCommandPort, HostModelSettingsPort } from "../host/hostPort";
import {
  createFakeBotSummary,
  createFakeConversationSnapshot,
  createFakeLiveFrame,
  createFakeModelSettingsView,
  createFakeSessionFrame,
  createFakeSessionPage,
} from "./fixtures";

export interface FakeHostCommandPortOptions {
  capabilities?: readonly RemoteCapability[];
  snapshot?: ConversationSnapshot;
  modelSettings?: RemoteModelSettingsView;
  bots?: readonly BotSummary[];
  sessionPage?: ConversationSessionPage;
}

export interface FakeHostCommandPort extends HostCommandPort {
  readonly sentCommands: RemoteSendCommand[];
  readonly cancelledTurnIds: string[];
  readonly cancelledConversationIds: string[];
  readonly appliedModels: RemoteModelConfig[];
  emitFrame(frame: SessionFrame): void;
  emitLiveFrame(frame: LiveFrame): void;
  emitSnapshot(snapshot: ConversationSnapshot): void;
}

export function createFakeHostCommandPort(
  options: FakeHostCommandPortOptions = {},
): FakeHostCommandPort {
  const capabilities = options.capabilities ?? ["coding", "model-settings"];
  const bots = options.bots ?? [createFakeBotSummary()];
  const sessionPage = options.sessionPage ?? createFakeSessionPage();
  const sentCommands: RemoteSendCommand[] = [];
  const cancelledTurnIds: string[] = [];
  const cancelledConversationIds: string[] = [];
  const appliedModels: RemoteModelConfig[] = [];
  const frames: SessionFrame[] = [];
  const frameListeners = new Set<(frame: SessionFrame) => void>();
  const liveFrameListeners = new Set<(frame: LiveFrame) => void>();
  const snapshotListeners = new Set<(snapshot: ConversationSnapshot) => void>();
  let currentSnapshot = options.snapshot ?? createFakeConversationSnapshot();
  let currentModelSettings = options.modelSettings ?? createFakeModelSettingsView();
  let turnSequence = 0;

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
    cancelledTurnIds,
    cancelledConversationIds,
    appliedModels,
    capabilities: () => capabilities,
    async createConversation(conversationId) {
      currentSnapshot = {
        conversationId,
        lastSeq: 0,
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
    async readFrames(_conversationId, afterSeq) {
      return frames.filter((frame) => frame.seq > afterSeq);
    },
    async listSessions() {
      return sessionPage;
    },
    async send(command) {
      sentCommands.push(command);
      turnSequence += 1;
      return {
        queueId: `queue-${turnSequence}`,
        status: "started",
        position: 0,
        turnId: `turn-${turnSequence}`,
        snapshot: currentSnapshot,
      };
    },
    async waitQueue(_conversationId, queueId) {
      return { queueId, turnId: `turn-${turnSequence}`, outcome: "completed" };
    },
    async waitQueueStart(_conversationId, queueId) {
      return { queueId, turnId: `turn-${turnSequence}`, snapshot: currentSnapshot };
    },
    cancel(conversationId, turnId) {
      cancelledConversationIds.push(conversationId);
      cancelledTurnIds.push(turnId);
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
    onFrame(listener) {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    onLiveFrame(listener) {
      liveFrameListeners.add(listener);
      return () => liveFrameListeners.delete(listener);
    },
    emitFrame(frame) {
      frames.push(frame);
      for (const listener of frameListeners) listener(frame);
    },
    emitLiveFrame(frame) {
      for (const listener of liveFrameListeners) listener(frame);
    },
    emitSnapshot(snapshot) {
      currentSnapshot = snapshot;
      for (const listener of snapshotListeners) listener(snapshot);
    },
  };
}

export function createFakeSessionFrameForConversation(
  conversationId: string,
  seq = 1,
): SessionFrame {
  return {
    ...createFakeSessionFrame(seq),
    sessionId: conversationId,
  };
}

export function createFakeLiveFrameForConversation(conversationId: string): LiveFrame {
  return {
    ...createFakeLiveFrame(),
    sessionId: conversationId,
  };
}

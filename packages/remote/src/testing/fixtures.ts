import type {
  BotSummary,
  ConversationSessionPage,
  ConversationSnapshot,
  LiveFrame,
  RemoteModelConfig,
  RemoteModelSettingsView,
  SessionFrame,
} from "@answra/shared/schema";

export function createFakeConversationSnapshot(
  overrides: Partial<ConversationSnapshot> = {},
): ConversationSnapshot {
  return {
    conversationId: "conversation-1",
    lastSeq: 0,
    messages: [],
    ...overrides,
  };
}

export function createFakeSessionPage(
  overrides: Partial<ConversationSessionPage> = {},
): ConversationSessionPage {
  return {
    items: [
      {
        conversationId: "conversation-1",
        scope: "conversation",
        title: "Remote session",
        messageCount: 2,
        createdAt: "2026-11-13T00:00:00.000Z",
        updatedAt: "2026-11-13T00:01:00.000Z",
      },
    ],
    ...overrides,
  };
}

export function createFakeSessionFrame(seq = 1): SessionFrame {
  return {
    schemaVersion: 2,
    sessionId: "conversation-1",
    seq,
    eventId: `frame-${seq}`,
    occurredAt: "2026-11-13T00:00:00.000Z",
    producerId: "fake-host",
    turnId: "turn-1",
    messageId: "assistant-1",
    event: {
      type: "session-item",
      item: {
        seq,
        itemId: `text-${seq}`,
        status: "complete",
        createdAt: "2026-11-13T00:00:00.000Z",
        turnId: "turn-1",
        messageId: "assistant-1",
        payload: { kind: "text", text: "hello" },
      },
    },
  };
}

export function createFakeLiveFrame(): LiveFrame {
  return {
    sessionId: "conversation-1",
    messageId: "assistant-1",
    event: { type: "text-delta", partId: "text-1", delta: "hello" },
  };
}

export function createFakeBotSummary(overrides: Partial<BotSummary> = {}): BotSummary {
  return {
    id: "coding.engineer",
    name: "Coding Engineer",
    role: "engineer",
    responsibility: "coding",
    owns: ["workspace"],
    ...overrides,
  };
}

export function createFakeModelSettingsView(
  overrides: Partial<RemoteModelSettingsView> = {},
): RemoteModelSettingsView {
  return {
    source: "local",
    baseUrl: "http://127.0.0.1:1234/v1",
    chatModel: "local-model",
    configured: true,
    ...overrides,
  };
}

export function createFakeModelConfig(): RemoteModelConfig {
  return {
    chat: { baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", auth: "local" },
    answer: { baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", auth: "local" },
  };
}

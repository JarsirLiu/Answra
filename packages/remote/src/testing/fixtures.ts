import type {
  AgentEventEnvelope,
  BotSummary,
  ConversationSessionPage,
  ConversationSnapshot,
  RemoteModelConfig,
  RemoteModelSettingsView,
} from "@answra/shared/schema";

export function createFakeConversationSnapshot(
  overrides: Partial<ConversationSnapshot> = {},
): ConversationSnapshot {
  return {
    conversationId: "conversation-1",
    eventRevision: 0,
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

export function createFakeAgentEvent(sequence = 1): AgentEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    conversationId: "conversation-1",
    runId: "run-1",
    attemptId: "attempt-1",
    sequence,
    aggregateRevision: sequence,
    producerId: "fake-host",
    occurredAt: "2026-11-13T00:00:00.000Z",
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

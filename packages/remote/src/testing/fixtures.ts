import type {
  AgentEventEnvelope,
  BotSummary,
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
    messages: [],
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

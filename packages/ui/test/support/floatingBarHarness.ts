import type { ConversationMessage, ConversationSnapshot } from "@answra/shared";
import type { AgentEventEnvelope, AgentStreamEvent } from "@answra/shared/schema";
import { fireEvent, screen } from "@testing-library/react";
import type { UIMessageChunk } from "ai";
import { vi } from "vitest";

export const conversationId = "active-exam-conversation";

type ConversationEmitter = (event: { runId: string; chunk: UIMessageChunk }) => void;

export const conversationState: {
  emit: ConversationEmitter | undefined;
  emittedConversationId: string;
} = {
  emit: undefined,
  emittedConversationId: conversationId,
};

export const conversationListeners = new Set<(event: AgentEventEnvelope) => void>();

export function resetFloatingBarTestState() {
  localStorage.clear();
  vi.clearAllMocks();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.stealth;
  conversationState.emit = undefined;
  conversationState.emittedConversationId = conversationId;
  conversationListeners.clear();
}

function toStream(chunk: UIMessageChunk): AgentStreamEvent | undefined {
  switch (chunk.type) {
    case "start":
      return { type: "start" };
    case "text-start":
      return { type: "text-start", partId: chunk.id };
    case "text-end":
      return { type: "text-end", partId: chunk.id };
    case "text-delta":
      return { type: "text-delta", partId: chunk.id, delta: chunk.delta };
    case "reasoning-start":
      return { type: "reasoning-start", partId: chunk.id };
    case "reasoning-end":
      return { type: "reasoning-end", partId: chunk.id };
    case "reasoning-delta":
      return { type: "reasoning-delta", partId: chunk.id, delta: chunk.delta };
    case "tool-input-start":
      return {
        type: "tool-input-start",
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        ...(chunk.title === undefined ? {} : { title: chunk.title }),
      };
    case "tool-input-delta":
      return {
        type: "tool-input-delta",
        toolCallId: chunk.toolCallId,
        delta: chunk.inputTextDelta,
      };
    case "tool-input-available":
      return {
        type: "tool-call",
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        input: chunk.input,
      };
    case "tool-output-available":
      return { type: "tool-result", toolCallId: chunk.toolCallId, output: chunk.output };
    case "tool-input-error":
    case "tool-output-error":
      return {
        type: "tool-error",
        toolCallId: chunk.toolCallId,
        errorText: chunk.errorText,
      };
    case "source-url":
      return {
        type: "source-url",
        sourceId: chunk.sourceId,
        url: chunk.url,
        ...(chunk.title === undefined ? {} : { title: chunk.title }),
      };
    case "source-document":
      return {
        type: "source-document",
        sourceId: chunk.sourceId,
        mediaType: chunk.mediaType,
        title: chunk.title,
      };
    case "error":
      return { type: "error", errorText: chunk.errorText };
    default:
      return undefined;
  }
}

export function createConversationBridge() {
  const snapshots = new Map<string, ConversationSnapshot>();
  const snapshotFor = (id: string) => snapshots.get(id) ?? emptySnapshot(id);
  const saveSnapshot = (snapshot: ConversationSnapshot) => {
    snapshots.set(snapshot.conversationId, snapshot);
    return snapshot;
  };
  return {
    close: vi.fn(),
    fitContent: vi.fn(),
    getConversationSnapshot: vi.fn().mockImplementation(async (id: string) => snapshotFor(id)),
    readConversationEvents: vi.fn().mockResolvedValue([]),
    createConversation: vi
      .fn()
      .mockImplementation(async (id: string) => saveSnapshot(snapshotFor(id))),
    clearConversationMessages: vi.fn().mockImplementation(async (id: string) => {
      return saveSnapshot(emptySnapshot(id));
    }),
    sendConversationMessage: vi
      .fn()
      .mockImplementation(
        async (command: {
          conversationId: string;
          operation?: string;
          request?: { text?: string; images?: Array<{ name: string; dataUrl: string }> };
        }) => {
          conversationState.emittedConversationId = command.conversationId;
          // send returns the transcript snapshot; subsequent model output is carried by envelopes.
          if (command.operation && command.request) {
            const userMessage: ConversationMessage = {
              id: `user-${command.conversationId.slice(-8)}`,
              role: "user",
              text: command.request.text ?? "",
              images: command.request.images ?? [],
              status: "complete",
            };
            const assistantMessage: ConversationMessage = {
              id: "run-1",
              role: "assistant",
              text: "",
              images: [],
              status: "streaming",
            };
            const snapshot = saveSnapshot({
              conversationId: command.conversationId,
              eventRevision: 1,
              messages: [userMessage, assistantMessage],
              activeRunId: "run-1",
            });
            return {
              runId: "run-1",
              snapshot,
            };
          }
          return { runId: "run-1", snapshot: emptySnapshot(command.conversationId) };
        },
      ),
    sendInterviewMessage: vi.fn(async (id: string, text: string) => {
      const prior = snapshotFor(id);
      const snapshot = saveSnapshot({
        ...prior,
        eventRevision: prior.eventRevision,
        messages: [
          ...prior.messages,
          {
            id: `user-${prior.eventRevision + 1}`,
            role: "user",
            text,
            images: [],
            status: "complete",
          },
        ],
      });
      return { runId: "run-1", snapshot };
    }),
    cancelConversationRun: vi.fn(),
    onConversationEvent: vi.fn((listener: (event: AgentEventEnvelope) => void) => {
      let scopeId = "";
      let revision = 0;
      let seq = 0;
      const messages: ConversationMessage[] = [];
      conversationListeners.add(listener);
      const publish = (event: AgentEventEnvelope) => {
        conversationListeners.forEach((subscriber) => {
          subscriber(event);
        });
      };
      conversationState.emit = ({ runId, chunk }) => {
        if (scopeId !== conversationState.emittedConversationId) {
          scopeId = conversationState.emittedConversationId;
          revision = 1;
          seq = 0;
          messages.length = 0;
        }
        const stream = toStream(chunk);
        if (stream) {
          revision += 1;
          seq += 1;
          if (stream.type === "text-delta") {
            const assistant = messages.find((message) => message.id === runId);
            if (assistant) assistant.text += stream.delta;
            else
              messages.push({
                id: runId,
                role: "assistant",
                text: stream.delta,
                images: [],
                status: "streaming",
              });
            const snapshot = snapshotFor(conversationState.emittedConversationId);
            const assistantText =
              messages.find((message) => message.id === runId)?.text ?? stream.delta;
            saveSnapshot({
              ...snapshot,
              eventRevision: snapshot.eventRevision,
              messages: snapshot.messages.map((message) =>
                message.id === runId ? { ...message, text: assistantText } : message,
              ),
            });
          }
          publish({
            schemaVersion: 1,
            eventId: `event-${revision}`,
            attemptId: `${runId}:attempt:1`,
            producerId: "test",
            occurredAt: "2026-11-07T00:00:00.000Z",
            aggregateRevision: revision,
            sequence: seq,
            conversationId: conversationState.emittedConversationId,
            runId,
            event: stream,
          });
        }
        if (chunk.type === "finish" || chunk.type === "abort") {
          revision += 1;
          let assistant = messages.find((message) => message.id === runId);
          if (!assistant) {
            assistant = {
              id: runId,
              role: "assistant",
              text: "",
              images: [],
              status: "complete",
            };
            messages.push(assistant);
          }
          const snapshot = snapshotFor(conversationState.emittedConversationId);
          saveSnapshot({
            ...snapshot,
            eventRevision: revision,
            activeRunId: undefined,
            messages: snapshot.messages.map((message) =>
              message.id === runId ? { ...message, status: "complete" } : message,
            ),
          });
          publish({
            schemaVersion: 1,
            eventId: `event-${revision}`,
            attemptId: `${runId}:attempt:1`,
            producerId: "test",
            occurredAt: "2026-11-07T00:00:00.000Z",
            aggregateRevision: revision,
            sequence: seq + 1,
            conversationId: conversationState.emittedConversationId,
            runId,
            event: {
              type: "run-state-changed",
              state: chunk.type === "abort" ? "aborted" : "completed",
              attempt: 1,
            },
          });
        }
      };
      return () => {
        conversationListeners.delete(listener);
        if (conversationListeners.size === 0) conversationState.emit = undefined;
      };
    }),
    startRegionCapture: vi.fn().mockResolvedValue({
      dataUrl: "data:image/png;base64,QUJD",
      height: 200,
      ok: true,
      width: 300,
    }),
  };
}

function emptySnapshot(id = conversationId): ConversationSnapshot {
  return { conversationId: id, eventRevision: 0, messages: [] };
}

export function clickAnswerScreenshot() {
  if (!screen.queryByRole("button", { name: "截图提问" })) {
    fireEvent.click(screen.getByRole("button", { name: /^(对话|答题|面试)$/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "答题" }));
  }
  fireEvent.click(screen.getByRole("button", { name: "截图提问" }));
}

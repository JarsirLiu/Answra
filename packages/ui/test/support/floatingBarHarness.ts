import type { ConversationMessage, ConversationSnapshot } from "@answra/shared";
import { ActiveInterviewIntakeConversationId } from "@answra/shared";
import type {
  AgentDurableEvent,
  AgentEventEnvelope,
  AgentLiveOnlyEvent,
  AgentStreamEvent,
  LiveFrame,
  SessionFrame,
} from "@answra/shared/schema";
import { SESSION_FRAME_SCHEMA_VERSION } from "@answra/shared/schema";
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

/** Answer（P3 前）仍吃 envelope；会话/面试吃帧，两条通道各自独立。 */
export const conversationListeners = new Set<(event: AgentEventEnvelope) => void>();
export const sessionFrameListeners = new Set<(frame: SessionFrame) => void>();
export const liveFrameListeners = new Set<(frame: LiveFrame) => void>();

export function publishSessionFrame(frame: SessionFrame) {
  for (const listener of sessionFrameListeners) listener(frame);
}

export function publishLiveFrame(frame: LiveFrame) {
  for (const listener of liveFrameListeners) listener(frame);
}

/** 构造测试用 durable 事实帧；seq 由调用方决定，便于断言缺口与重放。 */
export function testFrame(
  seq: number,
  event: AgentDurableEvent,
  ids: { sessionId?: string; turnId?: string; messageId?: string } = {},
): SessionFrame {
  return {
    schemaVersion: SESSION_FRAME_SCHEMA_VERSION,
    sessionId: ids.sessionId ?? conversationState.emittedConversationId,
    seq,
    eventId: `event-${seq}`,
    occurredAt: "2026-11-07T00:00:00.000Z",
    producerId: "test",
    ...(ids.turnId === undefined ? {} : { turnId: ids.turnId }),
    ...(ids.messageId === undefined ? {} : { messageId: ids.messageId }),
    event,
  };
}

export function testLiveFrame(
  event: AgentLiveOnlyEvent,
  messageId = "run-1",
  sessionId = conversationState.emittedConversationId,
): LiveFrame {
  return { sessionId, messageId, event };
}

export function resetFloatingBarTestState() {
  localStorage.clear();
  vi.clearAllMocks();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.stealth;
  conversationState.emit = undefined;
  conversationState.emittedConversationId = conversationId;
  conversationListeners.clear();
  sessionFrameListeners.clear();
  liveFrameListeners.clear();
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
  const frameLog = new Map<string, SessionFrame[]>();
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
    readSessionFrames: vi
      .fn()
      .mockImplementation(async (id: string, afterSeq: number) =>
        (frameLog.get(id) ?? []).filter((frame) => frame.seq > afterSeq),
      ),
    createConversation: vi
      .fn()
      .mockImplementation(async (id: string) => saveSnapshot(snapshotFor(id))),
    clearConversationMessages: vi.fn().mockImplementation(async (id: string) => {
      // worker 清空会话时同时清空 journal 序号：帧从 1 重新开始，客户端游标也归零。
      frameLog.delete(id);
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
          // 发送只返回 transcript 快照；后续输出分别走 durable/live 帧与 Answer envelope。
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
              lastSeq: 1,
              messages: [userMessage, assistantMessage],
              activeTurnId: "turn-1",
              activeMessageId: "run-1",
            });
            if (command.operation === "answer.run") return { runId: "run-1", snapshot };
            return {
              queueId: "turn-1",
              status: "started" as const,
              position: 0 as const,
              turnId: "turn-1",
              snapshot,
            };
          }
          if (command.operation === "answer.run")
            return { runId: "run-1", snapshot: emptySnapshot(command.conversationId) };
          return {
            queueId: "turn-1",
            status: "started" as const,
            position: 0 as const,
            turnId: "turn-1",
            snapshot: emptySnapshot(command.conversationId),
          };
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
      return { turnId: "turn-1", snapshot };
    }),
    openInterviewIntake: vi.fn(async () => {
      const snapshot = saveSnapshot({
        conversationId: ActiveInterviewIntakeConversationId,
        eventRevision: 0,
        lastSeq: 0,
        messages: [
          {
            id: "intake-opening",
            role: "assistant",
            text: "我先看一下你的简历和项目。",
            images: [],
            status: "complete",
          },
        ],
      });
      return { snapshot };
    }),
    sendInterviewIntakeMessage: vi.fn(async (text: string) => {
      const prior = snapshotFor(ActiveInterviewIntakeConversationId);
      const snapshot = saveSnapshot({
        ...prior,
        messages: [
          ...prior.messages,
          {
            id: `user-${prior.messages.length + 1}`,
            role: "user",
            text,
            images: [],
            status: "complete",
          },
        ],
      });
      return { turnId: "turn-1", snapshot };
    }),
    getInterviewIntakeSnapshot: vi.fn(async () => snapshotFor(ActiveInterviewIntakeConversationId)),
    readInterviewIntakeEvents: vi.fn(async () => []),
    cancelTurn: vi.fn(),
    cancelConversationRun: vi.fn(),
    onSessionFrame: vi.fn((listener: (frame: SessionFrame) => void) => {
      sessionFrameListeners.add(listener);
      return () => {
        sessionFrameListeners.delete(listener);
      };
    }),
    onLiveFrame: vi.fn((listener: (frame: LiveFrame) => void) => {
      liveFrameListeners.add(listener);
      return () => {
        liveFrameListeners.delete(listener);
      };
    }),
    onConversationEvent: vi.fn((listener: (event: AgentEventEnvelope) => void) => {
      let scopeId = "";
      let revision = 0;
      let sequence = 0;
      const messages: ConversationMessage[] = [];
      conversationListeners.add(listener);
      const turnIdFor = (runId: string) => (runId === "run-1" ? "turn-1" : `turn-${runId}`);
      const publishEnvelope = (event: AgentEventEnvelope) => {
        conversationListeners.forEach((subscriber) => {
          subscriber(event);
        });
      };
      /** durable 事实按会话游标追加；live 增量不进历史，允许丢失。 */
      const publishFact = (id: string, event: AgentDurableEvent, runId: string) => {
        const log = frameLog.get(id) ?? [];
        const seq = (log.at(-1)?.seq ?? snapshotFor(id).lastSeq) + 1;
        const frame = testFrame(seq, event, {
          sessionId: id,
          turnId: turnIdFor(runId),
          messageId: runId,
        });
        log.push(frame);
        frameLog.set(id, log);
        saveSnapshot({ ...snapshotFor(id), lastSeq: seq });
        publishSessionFrame(frame);
      };
      conversationState.emit = ({ runId, chunk }) => {
        const id = conversationState.emittedConversationId;
        if (scopeId !== id) {
          scopeId = id;
          revision = 1;
          sequence = 0;
          messages.length = 0;
        }
        const stream = toStream(chunk);
        if (stream) {
          revision += 1;
          sequence += 1;
          if (isLiveOnly(stream))
            publishLiveFrame({ sessionId: id, messageId: runId, event: stream });
          else publishFact(id, stream, runId);
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
            const snapshot = snapshotFor(id);
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
          publishEnvelope({
            schemaVersion: 1,
            eventId: `event-${revision}`,
            attemptId: `${runId}:attempt:1`,
            producerId: "test",
            occurredAt: "2026-11-07T00:00:00.000Z",
            aggregateRevision: revision,
            sequence,
            conversationId: id,
            runId,
            event: stream,
          });
        }
        if (chunk.type === "finish" || chunk.type === "abort") {
          revision += 1;
          sequence += 1;
          if (!messages.some((message) => message.id === runId)) {
            messages.push({
              id: runId,
              role: "assistant",
              text: "",
              images: [],
              status: "complete",
            });
          }
          const aborted = chunk.type === "abort";
          publishFact(
            id,
            { type: "turn-finished", status: aborted ? "aborted" : "completed" },
            runId,
          );
          const snapshot = snapshotFor(id);
          saveSnapshot({
            ...snapshot,
            eventRevision: revision,
            activeTurnId: undefined,
            activeMessageId: undefined,
            messages: snapshot.messages.map((message) =>
              message.id === runId
                ? { ...message, status: aborted ? "interrupted" : "complete" }
                : message,
            ),
          });
          publishEnvelope({
            schemaVersion: 1,
            eventId: `event-${revision}`,
            attemptId: `${runId}:attempt:1`,
            producerId: "test",
            occurredAt: "2026-11-07T00:00:00.000Z",
            aggregateRevision: revision,
            sequence,
            conversationId: id,
            runId,
            event: {
              type: "run-state-changed",
              state: aborted ? "aborted" : "completed",
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
  return { conversationId: id, eventRevision: 0, lastSeq: 0, messages: [] };
}

/** live-only 增量不进 durable 历史：它们只改变瞬时正文，由后续快照兜底。 */
function isLiveOnly(event: AgentStreamEvent): event is AgentLiveOnlyEvent {
  return (
    event.type === "text-delta" ||
    event.type === "reasoning-delta" ||
    event.type === "tool-input-delta" ||
    event.type === "tool-output-delta"
  );
}

export function clickAnswerScreenshot() {
  if (!screen.queryByRole("button", { name: "截图提问" })) {
    fireEvent.click(screen.getByRole("button", { name: /^(对话|答题|面试)$/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "答题" }));
  }
  fireEvent.click(screen.getByRole("button", { name: "截图提问" }));
}

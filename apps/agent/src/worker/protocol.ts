import type {
  AnswerSendCommand,
  ChatSendCommand,
  ConversationImage,
  ConversationModelConfig,
  ConversationSelection,
  ConversationSnapshot,
  InterviewPcmFrame,
  InterviewProfileSeed,
  TeamSendCommand,
} from "@answra/shared";
import type { LiveFrame, SessionFrame } from "@answra/shared/schema";
import type { ConversationSessionQuery } from "../core/transcript/catalog";

export interface InterviewWorkerTranscriptChunk {
  utteranceId: string;
  chunkIndex: number;
  startSample: number;
  endSample: number;
  text: string;
}

export interface InterviewWorkerTurn {
  sessionId: string;
  conversationId: string;
  turnId: string;
  version: number;
  status: "provisional" | "committed" | "incomplete";
  chunks: readonly InterviewWorkerTranscriptChunk[];
  missingChunkIndexes: readonly number[];
}

/** Serializable worker DTOs intentionally do not expose Agent domain types. */
export type InterviewWorkerEvent =
  | { type: "session-started"; sessionId: string; conversationId: string }
  | {
      type: "session-state-changed";
      sessionId: string;
      conversationId: string;
      state: "starting" | "listening" | "stopping" | "stopped" | "failed";
    }
  | {
      type: "session-failed";
      sessionId: string;
      conversationId: string;
      code: "capture-failed" | "runtime-failed";
    }
  | { type: "session-stopped"; sessionId: string; conversationId: string }
  | {
      type: "transcript-event";
      event:
        | {
            kind: "partial" | "chunk-final";
            sessionId: string;
            source: "interviewer" | "candidate";
            utteranceId: string;
            chunkIndex: number;
            startSample: number;
            endSample: number;
            revision: number;
            boundary: "utterance-end" | "continuation";
            text: string;
          }
        | {
            kind: "error";
            sessionId: string;
            source: "interviewer" | "candidate";
            utteranceId: string;
            chunkIndex: number;
            startSample: number;
            endSample: number;
            revision: number;
            boundary: "utterance-end" | "continuation";
            code:
              | "invalid-audio"
              | "audio-too-short"
              | "audio-too-long"
              | "queue-full"
              | "timeout"
              | "unauthorized"
              | "provider-unavailable"
              | "provider-error"
              | "cancelled";
            retryable: boolean;
          };
    }
  | {
      type: "turn-started";
      sessionId: string;
      conversationId: string;
      turnId: string;
      version: number;
      startedAtSample: number;
    }
  | { type: "turn-updated"; turn: InterviewWorkerTurn & { status: "provisional" } }
  | { type: "turn-committed"; turn: InterviewWorkerTurn & { status: "committed" } }
  | { type: "turn-incomplete"; turn: InterviewWorkerTurn & { status: "incomplete" } }
  | {
      type: "audio-gap";
      sessionId: string;
      source: "interviewer" | "candidate";
      expectedSequence: number;
      receivedSequence: number;
      expectedStartSample: number;
      receivedStartSample: number;
    }
  | {
      type: "reply-invalidated";
      sessionId: string;
      turnId: string;
      generation: number;
      reason: "new-interviewer-speech" | "newer-turn" | "session-stopped";
    };

/**
 * desktop main ↔ agent worker 的线协议：命令下行、帧上行。
 * 只有这里出现在 utility process 边界上，会话与模型细节留在 src 内部。
 *
 * Agent 通过下行命令接收运行输入和授权上下文；Agent 工具在 Agent 进程内执行。
 * 仅云端访问令牌刷新使用专用反向请求帧。
 */
export type AgentCommand =
  | { id: string; type: "interview-start"; sessionId: string; conversationId: string }
  | { id: string; type: "interview-capture-ready"; sessionId: string }
  | { id: string; type: "interview-capture-failed"; sessionId: string }
  | { id: string; type: "interview-stop"; sessionId: string }
  /** High-frequency audio frames are one-way to avoid a worker response per frame. */
  | { type: "interview-audio-frame"; frame: InterviewPcmFrame }
  | { id: string; type: "configure"; config: ConversationModelConfig }
  | { id: string; type: "workspace-context"; root: string | null }
  | { id: string; type: "interview-context"; root: string | null; seed: InterviewProfileSeed }
  | { id: string; type: "interview-message"; conversationId: string; text: string }
  | { id: string; type: "interview-snapshot"; conversationId: string }
  | { id: string; type: "interview-rehearsal-open"; conversationId: string }
  | { id: string; type: "interview-assist-open"; conversationId: string }
  | { id: string; type: "interview-assist-message"; conversationId: string; text: string }
  | { id: string; type: "interview-assist-snapshot"; conversationId: string }
  | { id: string; type: "interview-intake-open"; conversationId: string }
  | {
      id: string;
      type: "interview-intake-message";
      conversationId: string;
      text: string;
      images: readonly ConversationImage[];
    }
  | { id: string; type: "interview-intake-snapshot"; conversationId: string }
  | ({ id: string; type: "chat-send"; accessToken: string } & ChatSendCommand)
  | ({ id: string; type: "team-send"; accessToken: string } & TeamSendCommand)
  | ({ id: string; type: "answer-send"; accessToken: string } & AnswerSendCommand)
  /** 宿主对 `token-request` 的回答：`accessToken` 与 `error` 二者必居其一。 */
  | { id: string; type: "token"; accessToken?: string; error?: string }
  | { id: string; type: "snapshot"; conversationId: string }
  | { id: string; type: "bot-list" }
  | { id: string; type: "session-list"; query?: ConversationSessionQuery }
  | { id: string; type: "session-delete"; conversationId: string }
  /** 按 durable `seq` 读取可重放事实帧；会话、面试、Coding 与 Answer 共用。 */
  | { id: string; type: "read-frames"; conversationId: string; afterSeq: number }
  | {
      id: string;
      type: "create-conversation";
      conversationId: string;
      selection?: ConversationSelection;
    }
  | { id: string; type: "create-answer-conversation"; conversationId: string }
  | { id: string; type: "clear-conversation"; conversationId: string }
  | {
      id: string;
      type: "compact-conversation";
      conversationId: string;
      accessToken: string;
      instructions?: string;
    }
  | { id: string; type: "append-user-message"; conversationId: string; text: string }
  /** 取消指定 Turn；会话/面试/Coding/Answer 共用同一形状。 */
  | { id: string; type: "cancel-turn"; conversationId: string; turnId: string }
  | { id: string; type: "wait-queue"; conversationId: string; queueId: string }
  | { id: string; type: "wait-queue-start"; conversationId: string; queueId: string }
  | { id: string; type: "queue-position"; conversationId: string; queueId: string }
  /** 就绪探测：宿主在启动后确认 worker 能处理命令，连接域据此进入 connected。 */
  | { id: string; type: "ping" }
  | { id: string; type: "shutdown" };

export type AgentFrame =
  | { version: 1; type: "response"; id: string; ok: true; value?: unknown }
  | { version: 1; type: "response"; id: string; ok: false; error: string }
  /** durable 事实帧：可重放、带会话内连续 `seq`。 */
  | { version: 1; type: "session-frame"; frame: SessionFrame }
  /** live 增量帧：不可重放，丢失只影响瞬时观感。 */
  | { version: 1; type: "live-frame"; frame: LiveFrame }
  | { version: 1; type: "conversation-snapshot"; snapshot: ConversationSnapshot }
  /** Worker DTOs cross to desktop-main for projection into renderer contracts. */
  | { version: 1; type: "interview-event"; event: InterviewWorkerEvent }
  /** A batch acknowledgment releases a bounded number of renderer audio frames. */
  | { version: 1; type: "interview-audio-credit"; sessionId: string; count: number }
  /** 反向请求：云端调用收到 401 时，请宿主换一次新的访问令牌。 */
  | { version: 1; type: "token-request"; id: string; forceRefresh: boolean };

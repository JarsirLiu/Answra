import type {
  AnswerRunCommand,
  ChatSendCommand,
  ConversationChange,
  ConversationModelConfig,
  InterviewPcmFrame,
} from "@answra/shared";

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
 * 平台能力（如刷新云端访问令牌）由宿主实现：agent 只上行「请求帧」，宿主用命令帧回答。
 * agent 不持有宿主 API，也不接触磁盘上的凭据。
 */
export type AgentCommand =
  | { id: string; type: "interview-start"; sessionId: string; conversationId: string }
  | { id: string; type: "interview-capture-ready"; sessionId: string }
  | { id: string; type: "interview-capture-failed"; sessionId: string }
  | { id: string; type: "interview-stop"; sessionId: string }
  /** High-frequency audio frames are one-way to avoid a worker response per frame. */
  | { type: "interview-audio-frame"; frame: InterviewPcmFrame }
  | { id: string; type: "configure"; config: ConversationModelConfig }
  | ({ id: string; type: "chat-send"; accessToken: string } & ChatSendCommand)
  | ({ id: string; type: "answer-run"; accessToken: string } & AnswerRunCommand)
  /** 宿主对 `token-request` 的回答：`accessToken` 与 `error` 二者必居其一。 */
  | { id: string; type: "token"; accessToken?: string; error?: string }
  | { id: string; type: "snapshot"; conversationId: string }
  | { id: string; type: "read-events"; conversationId: string; afterRevision: number }
  | { id: string; type: "create-conversation"; conversationId: string }
  | { id: string; type: "cancel"; runId: string }
  | { id: string; type: "shutdown" };

export type AgentFrame =
  | { version: 1; type: "response"; id: string; ok: true; value?: unknown }
  | { version: 1; type: "response"; id: string; ok: false; error: string }
  | { version: 1; type: "change"; change: ConversationChange }
  /** Worker DTOs cross to desktop-main for projection into renderer contracts. */
  | { version: 1; type: "interview-event"; event: InterviewWorkerEvent }
  /** A batch acknowledgment releases a bounded number of renderer audio frames. */
  | { version: 1; type: "interview-audio-credit"; sessionId: string; count: number }
  /** 反向请求：云端调用收到 401 时，请宿主换一次新的访问令牌。 */
  | { version: 1; type: "token-request"; id: string; forceRefresh: boolean };

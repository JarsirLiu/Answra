/**
 * Interview domain contracts. These types describe meaning inside the Agent;
 * IPC DTOs and provider wire formats must be mapped at their own boundaries.
 */

export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type SessionId = Brand<string, "SessionId">;
/** Stable history key shared with the existing text conversation runtime. */
export type ConversationId = Brand<string, "ConversationId">;
export type UtteranceId = Brand<string, "UtteranceId">;
export type TurnId = Brand<string, "TurnId">;
export type ReplyGeneration = Brand<number, "ReplyGeneration">;

export function sessionId(value: string): SessionId {
  return nonEmptyId(value, "sessionId") as SessionId;
}

export function conversationId(value: string): ConversationId {
  return nonEmptyId(value, "conversationId") as ConversationId;
}

export function utteranceId(value: string): UtteranceId {
  return nonEmptyId(value, "utteranceId") as UtteranceId;
}

export function turnId(value: string): TurnId {
  return nonEmptyId(value, "turnId") as TurnId;
}

export function replyGeneration(value: number): ReplyGeneration {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError("reply generation must be a non-negative safe integer");
  return value as ReplyGeneration;
}

function nonEmptyId(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new TypeError(`${name} must not be empty`);
  return value;
}

export type AudioSource = "interviewer" | "candidate";
export type PcmSampleRate = 16_000;
/** Target frame duration is 100 ms; the final frame may be shorter. */
export const PCM_FRAME_MAX_SAMPLES = 1_600;
export const PCM_FRAME_MAX_BYTES = PCM_FRAME_MAX_SAMPLES * 2;

/** Audio time is measured in sample frames from the start of each source track. */
export interface PcmFrame {
  sessionId: SessionId;
  source: AudioSource;
  /** Zero-based sequence, increasing independently for each source. */
  sequence: number;
  /** Start position in this source track; one sample frame is one mono sample. */
  startSample: number;
  sampleRate: PcmSampleRate;
  channels: 1;
  encoding: "pcm_s16le";
  /** 1..3200 owned bytes; transport encodings such as base64 stay outside the domain. */
  pcm: Uint8Array;
}

export type SpeechActivityEvent =
  | {
      type: "speech-started";
      sessionId: SessionId;
      source: AudioSource;
      utteranceId: UtteranceId;
      atSample: number;
      confidence: number;
    }
  | {
      type: "speech-ended";
      sessionId: SessionId;
      source: AudioSource;
      utteranceId: UtteranceId;
      atSample: number;
      confidence: number;
    };

export interface VadDetector {
  process(frame: PcmFrame): readonly SpeechActivityEvent[];
  reset(): void;
}

export type SegmentBoundary = "utterance-end" | "continuation";

export interface AudioSegment {
  sessionId: SessionId;
  source: AudioSource;
  utteranceId: UtteranceId;
  chunkIndex: number;
  startSample: number;
  endSample: number;
  sampleRate: PcmSampleRate;
  channels: 1;
  encoding: "pcm_s16le";
  pcm: Uint8Array;
  boundary: SegmentBoundary;
}

export interface AudioSegmenter {
  pushFrame(frame: PcmFrame, activity: readonly SpeechActivityEvent[]): readonly AudioSegment[];
  flush(sessionId: SessionId, source: AudioSource): readonly AudioSegment[];
  reset(sessionId: SessionId, source: AudioSource): void;
}

export type TranscriptionProvider =
  | {
      inputMode: "segment";
      transcribe(segment: AudioSegment, signal: AbortSignal): Promise<readonly TranscriptEvent[]>;
    }
  | {
      inputMode: "stream";
      openSession(options: {
        sessionId: SessionId;
        source: AudioSource;
        signal: AbortSignal;
        emit: (event: TranscriptEvent) => void;
      }): Promise<StreamingTranscriptionSession>;
    };

export interface StreamingTranscriptionSession {
  pushFrame(frame: PcmFrame): Promise<void>;
  close(): Promise<void>;
}

export interface TranscriptBase {
  sessionId: SessionId;
  source: AudioSource;
  utteranceId: UtteranceId;
  chunkIndex: number;
  startSample: number;
  endSample: number;
  revision: number;
}

export type TranscriptionErrorCode =
  | "invalid-audio"
  | "audio-too-long"
  | "queue-full"
  | "timeout"
  | "unauthorized"
  | "provider-unavailable"
  | "provider-error"
  | "cancelled";

export type TranscriptEvent =
  | (TranscriptBase & { kind: "partial"; text: string })
  | (TranscriptBase & { kind: "chunk-final"; text: string })
  | (TranscriptBase & {
      kind: "error";
      code: TranscriptionErrorCode;
      retryable: boolean;
    });

export interface TranscriptChunk {
  utteranceId: UtteranceId;
  chunkIndex: number;
  startSample: number;
  endSample: number;
  text: string;
}

export type InterviewTurnStatus = "provisional" | "committed" | "incomplete";

/** A snapshot sent to reply policy; turns are created only by the turn assembler. */
export interface InterviewerTurn {
  sessionId: SessionId;
  conversationId: ConversationId;
  turnId: TurnId;
  version: number;
  status: InterviewTurnStatus;
  chunks: readonly TranscriptChunk[];
  missingChunkIndexes: readonly number[];
}

export type InterviewTurnEvent =
  /** Emitted on reliable interviewer speech onset, before ASR text is available. */
  | {
      type: "turn-started";
      sessionId: SessionId;
      conversationId: ConversationId;
      turnId: TurnId;
      version: number;
      startedAtSample: number;
    }
  | {
      type: "turn-updated";
      turn: InterviewerTurn & { status: "provisional" };
    }
  | { type: "turn-committed"; turn: InterviewerTurn & { status: "committed" } }
  | { type: "turn-incomplete"; turn: InterviewerTurn & { status: "incomplete" } };

export type InterviewSessionState = "starting" | "listening" | "stopping" | "stopped" | "failed";

/** One audio runtime is attached to a persistent conversation history. */
export interface InterviewSession {
  sessionId: SessionId;
  conversationId: ConversationId;
  state: InterviewSessionState;
}

/** Audio and asynchronous results are valid only while this exact run listens. */
export function isCurrentListeningSession(
  session: InterviewSession,
  candidateSessionId: SessionId,
): boolean {
  return session.state === "listening" && session.sessionId === candidateSessionId;
}

export type InterviewSessionLifecycleEvent =
  | { type: "capture-ready"; sessionId: SessionId }
  | { type: "stop-requested"; sessionId: SessionId }
  | { type: "cleanup-completed"; sessionId: SessionId }
  | { type: "failed"; sessionId: SessionId; code: "capture-failed" | "runtime-failed" };

export type InterviewSessionTransitionResult =
  | { accepted: true; session: InterviewSession }
  | {
      accepted: false;
      reason: "stale-session" | "invalid-transition";
      session: InterviewSession;
    };

/** Pure lifecycle transition; callers own resource cleanup and event publication. */
export function transitionInterviewSession(
  session: InterviewSession,
  event: InterviewSessionLifecycleEvent,
): InterviewSessionTransitionResult {
  if (event.sessionId !== session.sessionId) {
    return { accepted: false, reason: "stale-session", session };
  }

  switch (event.type) {
    case "capture-ready":
      if (session.state !== "starting") break;
      return { accepted: true, session: { ...session, state: "listening" } };
    case "stop-requested":
      if (session.state === "stopping") return { accepted: true, session };
      if (session.state !== "starting" && session.state !== "listening") break;
      return { accepted: true, session: { ...session, state: "stopping" } };
    case "cleanup-completed":
      if (session.state !== "stopping") break;
      return { accepted: true, session: { ...session, state: "stopped" } };
    case "failed":
      if (session.state === "stopped" || session.state === "failed") break;
      return { accepted: true, session: { ...session, state: "failed" } };
  }

  return { accepted: false, reason: "invalid-transition", session };
}

export type InterviewSessionEvent =
  | { type: "session-started"; sessionId: SessionId; conversationId: ConversationId }
  | {
      type: "session-state-changed";
      sessionId: SessionId;
      conversationId: ConversationId;
      state: InterviewSessionState;
    }
  | {
      type: "session-failed";
      sessionId: SessionId;
      conversationId: ConversationId;
      code: "capture-failed" | "runtime-failed";
    }
  | { type: "session-stopped"; sessionId: SessionId; conversationId: ConversationId };

export type InterviewDomainEvent =
  | InterviewSessionEvent
  | { type: "transcript-event"; event: TranscriptEvent }
  | InterviewTurnEvent
  | {
      type: "audio-gap";
      sessionId: SessionId;
      source: AudioSource;
      expectedSequence: number;
      receivedSequence: number;
      expectedStartSample: number;
      receivedStartSample: number;
    }
  | {
      type: "reply-invalidated";
      sessionId: SessionId;
      turnId: TurnId;
      generation: ReplyGeneration;
      reason: "new-interviewer-speech" | "newer-turn" | "session-stopped";
    };

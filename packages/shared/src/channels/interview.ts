/** 面试采集、音频流和回答状态的 IPC 频道和载荷契约。 */
export const InterviewChannels = {
  Start: "answra:interview:start",
  Stop: "answra:interview:stop",
  CaptureReady: "answra:interview:capture-ready",
  CaptureFailed: "answra:interview:capture-failed",
  AudioFrame: "answra:interview:audio-frame",
  AudioCredit: "answra:interview:audio-credit",
  Change: "answra:interview:change",
} as const;

/** Bounds audio frames in flight while the Agent processes them in batches. */
export const INTERVIEW_AUDIO_CREDIT_WINDOW = 10;
export const INTERVIEW_AUDIO_CREDIT_BATCH = 5;

export type InterviewSpeaker = "interviewer" | "user";
export type InterviewAudioSource = "interviewer" | "candidate";
export type InterviewState = "connecting" | "listening" | "thinking" | "stopped" | "error";

export type InterviewChange =
  | { sessionId: string; type: "state"; state: InterviewState; message?: string }
  | {
      sessionId: string;
      type: "transcript";
      speaker: InterviewSpeaker;
      utteranceId: string;
      chunkIndex: number;
      text: string;
      final: boolean;
      turnEnd: boolean;
      timestamp: number;
    }
  | { sessionId: string; type: "answer-start"; questionId: string; question: string }
  | { sessionId: string; type: "answer"; questionId: string; text: string }
  | { sessionId: string; type: "answer-ignored"; questionId: string }
  | { sessionId: string; type: "answer-stale"; questionId: string };

/** Binary PCM IPC DTO. Provider and Agent domain types do not cross into shared. */
export interface InterviewPcmFrame {
  sessionId: string;
  source: InterviewAudioSource;
  sequence: number;
  startSample: number;
  sampleRate: 16_000;
  channels: 1;
  encoding: "pcm_s16le";
  pcm: Uint8Array;
}

export interface InterviewChannelMap {
  [InterviewChannels.Start]: {
    request: { conversationId: string };
    response: { sessionId: string };
  };
  [InterviewChannels.Stop]: { request: { sessionId: string }; response: undefined };
  [InterviewChannels.CaptureReady]: { request: { sessionId: string }; response: undefined };
  [InterviewChannels.CaptureFailed]: { request: { sessionId: string }; response: undefined };
  [InterviewChannels.AudioFrame]: { request: InterviewPcmFrame; response: undefined };
  [InterviewChannels.AudioCredit]: {
    request: { sessionId: string; count: number };
    response: undefined;
  };
  [InterviewChannels.Change]: { request: undefined; response: undefined };
}

export const ActiveExamConversationId = "active-exam-conversation";
export const ActiveChatConversationId = "active-chat-conversation";
export const ActiveInterviewConversationId = "active-interview-conversation";

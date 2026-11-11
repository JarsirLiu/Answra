import type { ConversationSnapshot } from "../schema";

/** 面试采集、音频流和回答状态的 IPC 频道和载荷契约。 */
export const InterviewChannels = {
  Start: "answra:interview:start",
  Message: "answra:interview:message",
  Stop: "answra:interview:stop",
  CaptureReady: "answra:interview:capture-ready",
  CaptureFailed: "answra:interview:capture-failed",
  AudioFrame: "answra:interview:audio-frame",
  AudioCredit: "answra:interview:audio-credit",
  Change: "answra:interview:change",
  OnboardingGetState: "answra:interview:onboarding-get-state",
  OnboardingPickResume: "answra:interview:onboarding-pick-resume",
  OnboardingImportResume: "answra:interview:onboarding-import-resume",
  OnboardingUpdate: "answra:interview:onboarding-update",
  OnboardingAddProject: "answra:interview:onboarding-add-project",
  OnboardingComplete: "answra:interview:onboarding-complete",
  OnboardingSkip: "answra:interview:onboarding-skip",
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

export const INTERVIEW_ONBOARDING_STEPS = ["resume", "projects", "ready"] as const;
export type InterviewOnboardingStep = (typeof INTERVIEW_ONBOARDING_STEPS)[number];

export const INTERVIEW_ONBOARDING_STATUSES = ["pending", "completed", "skipped"] as const;
export type InterviewOnboardingStatus = (typeof INTERVIEW_ONBOARDING_STATUSES)[number];

export const INTERVIEW_RESUME_TEXT_MAX_CHARS = 200_000;
export const INTERVIEW_RESUME_FILE_MAX_BYTES = 2_000_000;
export const INTERVIEW_RESUME_FILE_NAME_MAX_LENGTH = 200;
export const INTERVIEW_PROJECTS_MAX = 20;
export const INTERVIEW_PROJECT_ID_MAX_LENGTH = 160;
export const INTERVIEW_PROJECT_NAME_MAX_LENGTH = 120;
export const INTERVIEW_PROJECT_ROLE_MAX_LENGTH = 80;
export const INTERVIEW_PROJECT_PERIOD_MAX_LENGTH = 80;
export const INTERVIEW_PROJECT_SUMMARY_MAX_LENGTH = 500;
export const INTERVIEW_PROJECT_EVIDENCE_MAX_LENGTH = 1_000;
export const INTERVIEW_TARGET_ROLE_MAX_LENGTH = 120;

/** A project candidate extracted from the selected resume; evidence stays local to the panel. */
export interface InterviewOnboardingProject {
  id: string;
  name: string;
  role?: string;
  period?: string;
  summary?: string;
  evidence?: string;
}

export interface InterviewOnboardingResume {
  id: string;
  fileName: string;
  projects: InterviewOnboardingProject[];
}

export interface InterviewOnboardingState {
  version: 1;
  status: InterviewOnboardingStatus;
  step: InterviewOnboardingStep;
  resume: InterviewOnboardingResume | null;
  selectedProjectIds: string[];
  targetRole: string;
  updatedAt: string;
}

/** Renderer may only change draft fields; importing a resume and finalizing stay separate. */
export interface InterviewOnboardingPatch {
  step?: InterviewOnboardingStep;
  selectedProjectIds?: string[];
  targetRole?: string;
}

export interface InterviewResumePickResult {
  cancelled: boolean;
  state: InterviewOnboardingState;
}

export interface InterviewResumeImportRequest {
  fileName?: string;
  text: string;
}

export interface InterviewProjectAddRequest {
  name: string;
  summary?: string;
}

export function isInterviewOnboardingStep(value: unknown): value is InterviewOnboardingStep {
  return (
    typeof value === "string" && (INTERVIEW_ONBOARDING_STEPS as readonly string[]).includes(value)
  );
}

export function isInterviewOnboardingStatus(value: unknown): value is InterviewOnboardingStatus {
  return (
    typeof value === "string" &&
    (INTERVIEW_ONBOARDING_STATUSES as readonly string[]).includes(value)
  );
}

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
  [InterviewChannels.Message]: {
    request: { conversationId: string; text: string };
    response: { runId: string; snapshot: ConversationSnapshot };
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
  [InterviewChannels.OnboardingGetState]: {
    request: undefined;
    response: InterviewOnboardingState;
  };
  [InterviewChannels.OnboardingPickResume]: {
    request: undefined;
    response: InterviewResumePickResult;
  };
  [InterviewChannels.OnboardingImportResume]: {
    request: InterviewResumeImportRequest;
    response: InterviewOnboardingState;
  };
  [InterviewChannels.OnboardingUpdate]: {
    request: InterviewOnboardingPatch;
    response: InterviewOnboardingState;
  };
  [InterviewChannels.OnboardingAddProject]: {
    request: InterviewProjectAddRequest;
    response: InterviewOnboardingState;
  };
  [InterviewChannels.OnboardingComplete]: {
    request: undefined;
    response: InterviewOnboardingState;
  };
  [InterviewChannels.OnboardingSkip]: {
    request: undefined;
    response: InterviewOnboardingState;
  };
}

export const ActiveExamConversationId = "active-exam-conversation";
export const ActiveChatConversationId = "active-chat-conversation";
export const ActiveInterviewConversationId = "active-interview-conversation";

import type { ConversationSnapshot } from "../schema";

/** 面试采集、音频流和回答状态的 IPC 频道和载荷契约。 */
export const InterviewChannels = {
  Start: "answra:interview:start",
  Message: "answra:interview:message",
  Stop: "answra:interview:stop",
  IntakeOpen: "answra:interview:intake-open",
  IntakeMessage: "answra:interview:intake-message",
  IntakeSnapshot: "answra:interview:intake-snapshot",
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
  OnboardingReopen: "answra:interview:onboarding-reopen",
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

export const INTERVIEW_ONBOARDING_STATE_VERSION = 2;
/** Agent 维护的画像文件；desktop 只在首次引导完成时创建，之后由 AI 读写。 */
export const INTERVIEW_PROFILE_FILE = "profile.xml";
export const INTERVIEW_PROFILE_VERSION = 1;
export const INTERVIEW_RESUME_TEXT_MAX_CHARS = 200_000;
export const INTERVIEW_RESUME_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const INTERVIEW_RESUME_FILE_NAME_MAX_LENGTH = 200;
export const INTERVIEW_RESUME_PATH_MAX_LENGTH = 1_024;
export const INTERVIEW_PROJECTS_MAX = 20;
export const INTERVIEW_PROJECT_ID_MAX_LENGTH = 160;
export const INTERVIEW_PROJECT_NAME_MAX_LENGTH = 120;
export const INTERVIEW_PROJECT_LOCATION_MAX_LENGTH = 1_024;
export const INTERVIEW_PROJECT_SUMMARY_MAX_LENGTH = 500;
export const INTERVIEW_TARGET_ROLE_MAX_LENGTH = 120;

/** 用户手动录入的项目；AI 制作画像时按 location 读取代码。 */
export interface InterviewOnboardingProject {
  id: string;
  name: string;
  /** 本地路径或仓库地址；缺省表示 AI 只能从简历正文里找。 */
  location?: string;
  summary?: string;
}

export interface InterviewOnboardingResume {
  id: string;
  fileName: string;
  /** 原生文件框选出的绝对路径；AI 直接读取，不复制正文。 */
  sourcePath: string;
}

export interface InterviewOnboardingState {
  version: typeof INTERVIEW_ONBOARDING_STATE_VERSION;
  status: InterviewOnboardingStatus;
  step: InterviewOnboardingStep;
  resume: InterviewOnboardingResume | null;
  projects: InterviewOnboardingProject[];
  selectedProjectIds: string[];
  targetRole: string;
  updatedAt: string;
}

/** 引导交给 Agent 的只读种子；画像由 Agent 维护，种子只用于首次创建或感知用户最近的修改。 */
export interface InterviewProfileSeed {
  targetRole: string;
  resume: InterviewOnboardingResume | null;
  projects: InterviewOnboardingProject[];
  updatedAt: string;
}

export function emptyInterviewProfileSeed(): InterviewProfileSeed {
  return { targetRole: "", resume: null, projects: [], updatedAt: "" };
}

/** intake 打开结果：已有 transcript 时只返回快照；空会话会启动一次开场回复。 */
export interface InterviewIntakeOpenResult {
  snapshot: ConversationSnapshot;
  runId?: string;
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
  location?: string;
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
  [InterviewChannels.IntakeOpen]: {
    request: undefined;
    response: InterviewIntakeOpenResult;
  };
  [InterviewChannels.IntakeMessage]: {
    request: { text: string };
    response: { runId: string; snapshot: ConversationSnapshot };
  };
  [InterviewChannels.IntakeSnapshot]: {
    request: undefined;
    response: ConversationSnapshot;
  };
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
  [InterviewChannels.OnboardingReopen]: {
    request: undefined;
    response: InterviewOnboardingState;
  };
}

export const ActiveExamConversationId = "active-exam-conversation";
export const ActiveChatConversationId = "active-chat-conversation";
export const ActiveInterviewConversationId = "active-interview-conversation";
export const ActiveInterviewIntakeConversationId = "interview-intake";

export type InterviewCapturePhase = "idle" | "starting" | "listening" | "stopping" | "error";

/**
 * 电平窗口槽位数：适配器按它保留最近样本，波形按同样槽位铺满输入区；
 * 显示侧不足时以静默槽位补齐，两侧共用同一常量，不允许各自维护数量。
 */
export const INTERVIEW_INPUT_LEVEL_WINDOW = 48;

export interface InterviewCaptureState {
  phase: InterviewCapturePhase;
  message?: string;
  /** PCM frames confirmed by the Agent's audio-credit response. */
  agentConfirmedFrames?: number;
  /** Recent normalized RMS samples read from the active microphone stream; publisher caps how many are kept. */
  inputLevels?: readonly number[];
}

/** Desktop injects the platform capture adapter; UI owns only controls and status. */
export interface InterviewCapturePort {
  getState(): InterviewCaptureState;
  subscribe(listener: (state: InterviewCaptureState) => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

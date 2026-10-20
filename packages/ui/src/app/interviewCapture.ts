export type InterviewCapturePhase = "idle" | "starting" | "listening" | "stopping" | "error";

export interface InterviewCaptureState {
  phase: InterviewCapturePhase;
  message?: string;
}

/** Desktop injects the platform capture adapter; UI owns only controls and status. */
export interface InterviewCapturePort {
  getState(): InterviewCaptureState;
  subscribe(listener: (state: InterviewCaptureState) => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

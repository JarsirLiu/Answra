/** @answra/agent 的离线评测入口；向根级评测工具开放真实链路组件。 */
export { InterviewAudioIngress } from "./audio/ingress";
export type { AudioSegment, PcmFrame } from "./contracts";
export { conversationId, sessionId } from "./contracts";
export { LocalParaformerAdapter } from "./transcription/local/adapter";
export type { OfflineRecognizerModule } from "./transcription/local/recognizerPort";
export { TEN_VAD_ONSET_THRESHOLD, VAD_CLOSE_SILENCE_MS } from "./vad/config";
export { InterviewVadPipeline } from "./vad/pipeline";
export { createTenVadEngine } from "./vad/tenVadEngine";

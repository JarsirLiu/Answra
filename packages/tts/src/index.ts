export { createSpeechSanitizer, sanitizeSpeechText } from "./chunk/sanitize";
export { splitSpeechText } from "./chunk/split";
export type {
  TtsStreamChunkOptions,
  TtsStreamingChunker,
} from "./chunk/stream";
export { createStreamingChunker } from "./chunk/stream";
export {
  DEFAULT_TTS_TIMEOUT_MS,
  type TtsProviderOptions,
  type TtsSynthesisRequest,
  type TtsSynthesisResult,
} from "./contracts";
export {
  abortedError,
  isTtsProviderError,
  TtsProviderError,
} from "./errors";
export type { TtsProviderFactory, TtsProviderPort } from "./port";
export { createTtsProviderPort } from "./registry";
export {
  createTtsSpeaker,
  type TtsSpeaker,
  type TtsSpeakerOptions,
  type TtsSpeakOptions,
} from "./speaker";
export { createTtsStrategy } from "./strategies";
export type {
  TtsChunkTuning,
  TtsStrategy,
  TtsStrategyContext,
  TtsStrategyOptions,
} from "./strategies/types";
export type { TtsSegmentAudio, TtsUtterance } from "./utterance";

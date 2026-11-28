/** 策略注册表：未知策略显式失败，不做静默降级。 */
import type { TtsStrategyId } from "@answra/shared/tts";
import { TtsProviderError } from "../errors";
import { createSentencePipelineStrategy } from "./sentencePipeline";
import type { TtsStrategy, TtsStrategyOptions } from "./types";
import { createWholeTextStrategy } from "./wholeText";

export function createTtsStrategy(id: TtsStrategyId, options?: TtsStrategyOptions): TtsStrategy {
  switch (id) {
    case "whole-text":
      return createWholeTextStrategy();
    case "sentence-pipeline":
      return createSentencePipelineStrategy(options);
    default:
      throw new TtsProviderError("unsupported-strategy", `不支持的 TTS 策略：${String(id)}。`);
  }
}

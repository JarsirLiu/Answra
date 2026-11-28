/** 宿主唯一入口：组合协议适配器与合成策略。 */
import type { TtsProtocol, TtsProviderCapabilities, TtsStrategyId } from "@answra/shared/tts";
import { TTS_DEFAULT_STRATEGY } from "@answra/shared/tts";
import type { TtsProviderOptions } from "./contracts";
import { createTtsProviderPort } from "./registry";
import { createTtsStrategy } from "./strategies";
import type { TtsStrategyOptions } from "./strategies/types";
import type { TtsSegmentAudio, TtsUtterance } from "./utterance";

export interface TtsSpeakerOptions {
  /** 默认为 `sentence-pipeline`；手动朗读建议传 `whole-text`。 */
  readonly strategy?: TtsStrategyId;
  readonly strategyOptions?: TtsStrategyOptions;
}

export interface TtsSpeakOptions {
  readonly signal?: AbortSignal;
  /** 覆盖 speaker 默认策略；同一 speaker 可对不同消息用不同策略。 */
  readonly strategy?: TtsStrategyId;
  readonly strategyOptions?: TtsStrategyOptions;
}

export interface TtsSpeaker {
  /** 由 adapter 常量声明，不来自远端探测。 */
  readonly capabilities: TtsProviderCapabilities;
  /** 文本增量进，段音频按 sequence 递增出。 */
  speak(utterance: TtsUtterance, options?: TtsSpeakOptions): AsyncIterable<TtsSegmentAudio>;
}

/** 唯一构造点；未知协议或未知策略都显式抛 `TtsProviderError`。 */
export function createTtsSpeaker(
  protocol: TtsProtocol,
  provider: TtsProviderOptions,
  options: TtsSpeakerOptions = {},
): TtsSpeaker {
  const port = createTtsProviderPort(protocol, provider);
  // 构造期校验默认策略，未知策略立即失败，不等到第一次朗读。
  createTtsStrategy(options.strategy ?? TTS_DEFAULT_STRATEGY, options.strategyOptions);

  return {
    capabilities: port.capabilities,

    speak(utterance: TtsUtterance, speakOptions: TtsSpeakOptions = {}) {
      const strategy = createTtsStrategy(
        speakOptions.strategy ?? options.strategy ?? TTS_DEFAULT_STRATEGY,
        speakOptions.strategyOptions ?? options.strategyOptions,
      );
      return strategy.speak(utterance, { port, signal: speakOptions.signal });
    },
  };
}

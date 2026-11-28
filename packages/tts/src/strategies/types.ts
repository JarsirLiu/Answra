/** 合成策略契约：宿主只选 id，不实现切句、并发或排序。 */
import type { TtsProviderPort } from "../port";
import type { TtsSegmentAudio, TtsUtterance } from "../utterance";

export interface TtsChunkTuning {
  /** 开头允许在逗号处提前结束的段数。 */
  readonly boost?: number;
  /** boost/limit 段必须达到的词数。 */
  readonly minimumWords?: number;
  /** 目标最大词数。 */
  readonly maximumWords?: number;
}

export interface TtsStrategyOptions {
  /** 流水线策略的最大并发合成数；其它策略忽略。 */
  readonly concurrency?: number;
  readonly chunk?: TtsChunkTuning;
}

export interface TtsStrategyContext {
  readonly port: TtsProviderPort;
  readonly signal?: AbortSignal;
}

export interface TtsStrategy {
  speak(utterance: TtsUtterance, context: TtsStrategyContext): AsyncIterable<TtsSegmentAudio>;
}

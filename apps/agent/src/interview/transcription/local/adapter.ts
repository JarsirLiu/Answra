/**
 * 本地批式转录 provider：AudioSegment 整段一次推理，产出 chunk-final 或显式 error，
 * 无 partial、无静默降级。引擎经 OfflineRecognizerModule 注入；本文件不感知
 * sherpa、VAD、turn 或任何平台层。
 */

import type {
  AudioSegment,
  TranscriptBase,
  TranscriptEvent,
  TranscriptionErrorCode,
} from "../../contracts";
import type {
  OfflineRecognizerModule,
  OfflineRecognizerRecipe,
  OfflineRecognizerSession,
} from "./recognizerPort";

/**
 * 引擎约束（2026-10-21 spike 实测记档）：低于该时长的整段解码会触发引擎内部
 * Reshape 异常并产出空文本；此类超短段来自强切尾巴，解码无意义，跳过。
 */
const LOCAL_MIN_DECODE_SECONDS = 0.3;
/** 首个转录结果的 revision 从 0 起步（局部单调，重发才递增）。 */
const FIRST_TRANSCRIPT_REVISION = 0;

export type LocalParaformerProviderOptions = {
  module: OfflineRecognizerModule;
  recipe: OfflineRecognizerRecipe;
};

// 逐属性满足 TranscriptionProvider 的 segment 成员（联合类型不可 implements）。
export class LocalParaformerAdapter {
  readonly inputMode = "segment" as const;
  private readonly session: OfflineRecognizerSession;

  constructor(options: LocalParaformerProviderOptions) {
    // 加载失败即抛：composition root 不得在模型缺失时构造本 adapter。
    this.session = options.module.create(options.recipe);
  }

  async transcribe(
    segment: AudioSegment,
    signal: AbortSignal,
  ): Promise<readonly TranscriptEvent[]> {
    const durationSeconds = (segment.endSample - segment.startSample) / segment.sampleRate;
    if (durationSeconds < LOCAL_MIN_DECODE_SECONDS) return [];
    // 引擎解码是同步 native 调用、不可被事件循环抢占；取消语义只能在
    // 解码前后检查信号——解码中触发的 abort 会丢弃已完成结果并报 cancelled。
    if (signal.aborted) return [errorEvent(segment, "cancelled", false)];
    let text: string;
    try {
      text = this.decode(segment);
    } catch (error) {
      console.warn("[transcription-local] 引擎解码失败", error);
      return [errorEvent(segment, "provider-error", true)];
    }
    if (signal.aborted) return [errorEvent(segment, "cancelled", false)];
    return [event(segment, { kind: "chunk-final", text })];
  }

  private decode(segment: AudioSegment): string {
    const pcm = new Float32Array(segment.pcm.byteLength / 2);
    const view = new DataView(segment.pcm.buffer, segment.pcm.byteOffset, segment.pcm.byteLength);
    for (let i = 0; i < pcm.length; i += 1) pcm[i] = view.getInt16(i * 2, true) / 32768;
    return this.session.transcribeOnce({ samples: pcm, sampleRate: segment.sampleRate });
  }
}

function event(
  segment: AudioSegment,
  extra:
    | { kind: "chunk-final"; text: string }
    | { kind: "error"; code: TranscriptionErrorCode; retryable: boolean },
): TranscriptEvent {
  const base: TranscriptBase = {
    sessionId: segment.sessionId,
    source: segment.source,
    utteranceId: segment.utteranceId,
    chunkIndex: segment.chunkIndex,
    startSample: segment.startSample,
    endSample: segment.endSample,
    revision: FIRST_TRANSCRIPT_REVISION,
  };
  return { ...base, ...extra };
}

function errorEvent(
  segment: AudioSegment,
  code: TranscriptionErrorCode,
  retryable: boolean,
): TranscriptEvent {
  return event(segment, { kind: "error", code, retryable });
}

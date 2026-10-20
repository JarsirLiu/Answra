import {
  type AudioSegment,
  type AudioSegmenter,
  type AudioSource,
  PCM_FRAME_MAX_SAMPLES,
  type PcmFrame,
  type SegmentBoundary,
  type SessionId,
  type SpeechActivityEvent,
  type UtteranceId,
} from "../contracts";
import {
  msToSamples,
  VAD_CHUNK_OVERLAP_SAMPLES,
  VAD_MAX_CHUNK_MS,
  VAD_MAX_GAP_FRAMES,
  VAD_PRE_ROLL_MS,
} from "./config";

/**
 * 分段器：把「帧 + 语音事件」折叠成 AudioSegment。
 * 一个实例服务一个 (会话, 通道)；边界与去重语义见 10-16 Note：
 * - speech-started：以 ≤ VAD_PRE_ROLL_MS 的预滚打开 chunk（事件回溯说明此刻
 *   部分样本已进入环形缓冲，预滚由 ring 提供）。
 * - 长语音达到 VAD_MAX_CHUNK_MS 时按最低 RMS 强切；后继 chunk 从切点前
 *   VAD_CHUNK_OVERLAP_SAMPLES 处开始，以 continuation 标记衔接。
 * - speech-ended / flush 闭合 chunk，boundary=utterance-end。
 * - 帧序空洞按静默补零（≤ VAD_MAX_GAP_FRAMES 帧），更长的撕裂由 pipeline 显式失败。
 */

const RMS_WINDOW_SAMPLES = 160;

interface OpenChunk {
  utteranceId: UtteranceId;
  chunkIndex: number;
  chunkStartSample: number;
  /** 与 chunkStartSample 对齐并随流增长的 PCM 字节。 */
  pcm: Uint8Array;
}

export class VadSegmenter implements AudioSegmenter {
  private readonly sessionId: SessionId;
  private readonly source: AudioSource;
  private readonly preRollSamples = msToSamples(VAD_PRE_ROLL_MS);
  private readonly maxChunkSamples = msToSamples(VAD_MAX_CHUNK_MS);
  private readonly maxGapSamples = VAD_MAX_GAP_FRAMES * PCM_FRAME_MAX_SAMPLES;
  private open?: OpenChunk;
  private readonly ring: Uint8Array = new Uint8Array(this.preRollSamples * 2);
  private ringSamples = 0;
  private ringStartSample = 0;
  /** undefined = 尚未收到首帧；否则等于已接收流的末尾绝对采样位置。 */
  private streamEndSample?: number;

  constructor(sessionId: SessionId, source: AudioSource) {
    this.sessionId = sessionId;
    this.source = source;
  }

  pushFrame(frame: PcmFrame, activity: readonly SpeechActivityEvent[]): readonly AudioSegment[] {
    const segments: AudioSegment[] = [];
    const receivedEndSample = frame.startSample + frame.pcm.byteLength / 2;
    const firstFrame = this.streamEndSample === undefined;
    const streamEnd = this.streamEndSample;
    if (streamEnd !== undefined && frame.startSample > streamEnd) {
      this.absorbSilence(frame.startSample);
    }
    if (firstFrame) {
      this.streamEndSample = frame.startSample;
    }
    this.pushRing(frame.pcm);
    this.streamEndSample = receivedEndSample;
    const hadOpen = this.open !== undefined;
    for (const event of activity) {
      if (event.type === "speech-started") this.openChunk(event);
      else this.closeChunk(event.atSample, "utterance-end", segments);
    }
    if (this.open && hadOpen) this.appendChunk(frame.pcm);
    this.splitLongChunk(segments);
    return segments;
  }

  flush(_sessionId: SessionId, _source: AudioSource): readonly AudioSegment[] {
    const segments: AudioSegment[] = [];
    this.closeChunk(this.streamEndSample ?? 0, "utterance-end", segments);
    this.clear();
    return segments;
  }

  reset(_sessionId: SessionId, _source: AudioSource): void {
    this.clear();
  }

  private clear(): void {
    this.open = undefined;
    this.ringSamples = 0;
    this.ringStartSample = this.streamEndSample ?? 0;
  }

  /** 缺失的帧与流末尾之间的伤口按静默补零，保持 PCM 与采样范围索引一致。 */
  private absorbSilence(receivedStartSample: number): void {
    const gapSamples = receivedStartSample - (this.streamEndSample ?? 0);
    if (gapSamples > this.maxGapSamples)
      throw new Error(`音频撕裂超出可补范围：${gapSamples} 样本`);
    const silence = new Uint8Array(gapSamples * 2);
    this.pushRing(silence);
    this.appendChunk(silence);
  }

  private pushRing(bytes: Uint8Array): void {
    if (this.ringSamples === 0) this.ringStartSample = this.streamEndSample ?? 0;
    const combined = new Uint8Array(this.ringSamples + bytes.length);
    combined.set(this.ring.subarray(0, this.ringSamples));
    combined.set(bytes, this.ringSamples);
    const overflow = Math.max(0, combined.length - this.ring.length);
    this.ringSamples = combined.length - overflow;
    if (overflow === 0) this.ring.set(combined.subarray(0, this.ringSamples));
    else {
      this.ringStartSample += overflow / 2;
      this.ring.set(combined.subarray(overflow));
    }
  }

  private openChunk(event: Extract<SpeechActivityEvent, { type: "speech-started" }>): void {
    // detector 保证 started→ended 配对；未闭合的 open 说明事件序契约被破坏。
    if (this.open) throw new Error("检测器在上一个 utterance 闭合前又发出 speech-started");
    if (this.ringSamples === 0) throw new Error("speech-started 缺少可用的预滚缓冲");
    const chunkStartSample = Math.max(
      this.ringStartSample,
      event.atSample - this.preRollSamples,
      0,
    );
    this.open = {
      utteranceId: event.utteranceId,
      chunkIndex: 0,
      chunkStartSample,
      pcm: this.ringWindow(chunkStartSample),
    };
  }

  private appendChunk(bytes: Uint8Array): void {
    const open = this.open;
    if (!open) return;
    const pcm = new Uint8Array(open.pcm.length + bytes.length);
    pcm.set(open.pcm);
    pcm.set(bytes, open.pcm.length);
    open.pcm = pcm;
  }

  private ringWindow(fromSample: number): Uint8Array {
    const offset = (fromSample - this.ringStartSample) * 2;
    if (offset < 0 || offset > this.ringSamples) throw new Error("预滚取样超出环形缓冲覆盖范围");
    return this.ring.subarray(offset, this.ringSamples).slice();
  }

  private closeChunk(endSample: number, boundary: SegmentBoundary, segments: AudioSegment[]): void {
    const open = this.open;
    if (!open) return;
    const endInPcm = Math.max(0, endSample - open.chunkStartSample);
    const pcm = open.pcm.subarray(0, endInPcm * 2).slice();
    this.open = undefined;
    segments.push({
      sessionId: this.sessionId,
      source: this.source,
      utteranceId: open.utteranceId,
      chunkIndex: open.chunkIndex,
      startSample: open.chunkStartSample,
      endSample: open.chunkStartSample + pcm.length / 2,
      sampleRate: 16_000,
      channels: 1,
      encoding: "pcm_s16le",
      pcm,
      boundary,
    });
  }

  private splitLongChunk(segments: AudioSegment[]): void {
    const open = this.open;
    if (!open || open.pcm.length / 2 < this.maxChunkSamples) return;
    const chunkSamples = open.pcm.length / 2;
    const cutOffset = Math.min(
      chunkSamples - 1,
      Math.max(VAD_CHUNK_OVERLAP_SAMPLES, lowestRmsSampleOffset(open.pcm)),
    );
    const cutSample = open.chunkStartSample + cutOffset;
    const startSample = cutSample - VAD_CHUNK_OVERLAP_SAMPLES;
    const pcm = open.pcm
      .subarray((cutOffset - VAD_CHUNK_OVERLAP_SAMPLES) * 2, cutOffset * 2)
      .slice();
    this.closeChunk(cutSample, "continuation", segments);
    this.open = {
      utteranceId: open.utteranceId,
      chunkIndex: open.chunkIndex + 1,
      chunkStartSample: startSample,
      pcm,
    };
  }
}

/** 10ms 窗扫描最低 RMS，返回窗中心相对 chunk 的采样偏移。 */
function lowestRmsSampleOffset(pcm: Uint8Array): number {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1);
  let minOffset = 0;
  let minSumSquares = Number.POSITIVE_INFINITY;
  for (let start = 0; start + RMS_WINDOW_SAMPLES <= samples.length; start += RMS_WINDOW_SAMPLES) {
    let sumSquares = 0;
    for (const value of samples.subarray(start, start + RMS_WINDOW_SAMPLES))
      sumSquares += value ** 2;
    if (sumSquares < minSumSquares) {
      minSumSquares = sumSquares;
      minOffset = start;
    }
  }
  return minOffset + (RMS_WINDOW_SAMPLES >> 1);
}

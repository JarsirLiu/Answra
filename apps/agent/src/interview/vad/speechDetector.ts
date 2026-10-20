import {
  PCM_FRAME_MAX_SAMPLES,
  type PcmFrame,
  type SessionId,
  type SpeechActivityEvent,
  type UtteranceId,
  utteranceId,
  type VadDetector,
} from "../contracts";
import { msToSamples, VAD_CLOSE_SILENCE_MS, VAD_MAX_GAP_FRAMES, VAD_MIN_SPEECH_MS } from "./config";
import type { HopVerdict } from "./tenVadEngine";

/**
 * 纯状态机：把逐 hop 的 {probability, flag} 折叠成 SpeechActivityEvent。
 * 结构对 hop 引擎保持中立（测试注入假 hop）；utteranceId 的唯一写者在这里；
 * sessionId/source 由构造参数提供（pipeline 按会话+通道建实例），不自行推演。
 *
 * 状态语义（阈值占位，阶段 8 实测校准）：
 * - idle → pending：语音 flag 起点；攒足 VAD_MIN_SPEECH_MS 真语音后回溯发 started；
 *   若真语音不足且静音 ≥ VAD_CLOSE_SILENCE_MS，丢弃 onset（短噪声 blip 不产出 utterance）。
 * - pending/speaking 内的短停顿（< close 阈值）不闭合，保持同一 utterance。
 * - speaking → idle：静音 ≥ close 阈值时发 speech-ended，atSample 回溯到最后一个语音样本。
 * - atSample 一律是源轨道的绝对采样位置（与 PcmFrame.startSample 同一坐标系）。
 */

export interface HopVad {
  hopSamples: number;
  processHop(samples: Int16Array): HopVerdict;
}

interface PendingPhase {
  kind: "pending";
  onsetSample: number;
  speechSamples: number;
  silenceSamples: number;
  lastSpeechEndSample: number;
  maxProbability: number;
}

interface SpeakingPhase {
  kind: "speaking";
  utteranceId: UtteranceId;
  silenceSamples: number;
  lastSpeechEndSample: number;
  maxProbability: number;
}

type Phase = { kind: "idle" } | PendingPhase | SpeakingPhase;

export class SpeechActivityDetector implements VadDetector {
  private readonly hop: HopVad;
  private readonly sessionId: SessionId;
  private readonly source: PcmFrame["source"];
  private readonly minSpeechSamples = msToSamples(VAD_MIN_SPEECH_MS);
  private readonly closeSilenceSamples = msToSamples(VAD_CLOSE_SILENCE_MS);
  private readonly maxGapSamples = VAD_MAX_GAP_FRAMES * PCM_FRAME_MAX_SAMPLES;
  private phase: Phase = { kind: "idle" };
  private utteranceSeq = 0;
  /** record[0] 对应的绝对采样位置；undefined 表示尚未收到任何帧。 */
  private hopCursor?: number;
  private record: Int16Array = new Int16Array(0);

  constructor(hop: HopVad, sessionId: SessionId, source: PcmFrame["source"]) {
    this.hop = hop;
    this.sessionId = sessionId;
    this.source = source;
  }

  process(frame: PcmFrame): readonly SpeechActivityEvent[] {
    this.consumeFrame(frame);
    const events: SpeechActivityEvent[] = [];
    while (this.record.length >= this.hop.hopSamples) {
      const hopStartSample = this.hopCursor;
      if (hopStartSample === undefined) throw new Error("vad hop 时间轴未初始化");
      const verdict = this.hop.processHop(this.record.subarray(0, this.hop.hopSamples));
      const event = this.advance(verdict, hopStartSample);
      if (event) events.push(event);
      this.hopCursor = hopStartSample + this.hop.hopSamples;
      this.record.copyWithin(0, this.hop.hopSamples);
      this.record = this.record.subarray(0, this.record.length - this.hop.hopSamples);
    }
    return events;
  }

  reset(): void {
    this.phase = { kind: "idle" };
    this.hopCursor = undefined;
    this.record = new Int16Array(0);
  }

  private consumeFrame(frame: PcmFrame): void {
    if (this.hopCursor === undefined) this.hopCursor = frame.startSample;
    const expectedStart = this.hopCursor + this.record.length;
    if (frame.startSample < expectedStart) throw new Error("vad 输入帧与 hop 时间轴不连续");
    const gapSamples = frame.startSample - expectedStart;
    if (gapSamples > this.maxGapSamples)
      throw new Error(`音频撕裂超出可补范围：${gapSamples} 样本`);
    if (gapSamples > 0) this.record = concat(this.record, new Int16Array(gapSamples));
    const incoming = new Int16Array(
      frame.pcm.buffer,
      frame.pcm.byteOffset,
      frame.pcm.byteLength >> 1,
    );
    const record = new Int16Array(this.record.length + incoming.length);
    record.set(this.record);
    record.set(incoming, this.record.length);
    this.record = record;
  }

  private advance(verdict: HopVerdict, hopStartSample: number): SpeechActivityEvent | undefined {
    const hopEndSample = hopStartSample + this.hop.hopSamples;
    const phase = this.phase;
    if (phase.kind === "idle") {
      if (!verdict.voiced) return undefined;
      this.phase = {
        kind: "pending",
        onsetSample: hopStartSample,
        speechSamples: this.hop.hopSamples,
        silenceSamples: 0,
        lastSpeechEndSample: hopEndSample,
        maxProbability: verdict.probability,
      };
      return undefined;
    }
    if (phase.kind === "pending") {
      this.absorb(phase, verdict, hopEndSample);
      return this.settlePending(phase);
    }
    return this.settleSpeaking(phase, verdict, hopEndSample);
  }

  private absorb(phase: PendingPhase, verdict: HopVerdict, hopEndSample: number): void {
    if (!verdict.voiced) {
      phase.silenceSamples += this.hop.hopSamples;
      return;
    }
    phase.speechSamples += this.hop.hopSamples;
    phase.silenceSamples = 0;
    phase.lastSpeechEndSample = hopEndSample;
    phase.maxProbability = Math.max(phase.maxProbability, verdict.probability);
  }

  private settlePending(phase: PendingPhase): SpeechActivityEvent | undefined {
    if (phase.speechSamples < this.minSpeechSamples) {
      if (phase.silenceSamples >= this.closeSilenceSamples) this.phase = { kind: "idle" };
      return undefined;
    }
    this.utteranceSeq += 1;
    const id = utteranceId(`${this.source}-${this.utteranceSeq}`);
    this.phase = {
      kind: "speaking",
      utteranceId: id,
      silenceSamples: 0,
      lastSpeechEndSample: phase.lastSpeechEndSample,
      maxProbability: phase.maxProbability,
    };
    return {
      type: "speech-started",
      sessionId: this.sessionId,
      source: this.source,
      utteranceId: id,
      atSample: phase.onsetSample,
      confidence: phase.maxProbability,
    };
  }

  private settleSpeaking(
    phase: SpeakingPhase,
    verdict: HopVerdict,
    hopEndSample: number,
  ): SpeechActivityEvent | undefined {
    if (verdict.voiced) {
      phase.silenceSamples = 0;
      phase.lastSpeechEndSample = hopEndSample;
      phase.maxProbability = Math.max(phase.maxProbability, verdict.probability);
      return undefined;
    }
    phase.silenceSamples += this.hop.hopSamples;
    if (phase.silenceSamples < this.closeSilenceSamples) return undefined;
    const id = phase.utteranceId;
    this.phase = { kind: "idle" };
    return {
      type: "speech-ended",
      sessionId: this.sessionId,
      source: this.source,
      utteranceId: id,
      atSample: phase.lastSpeechEndSample,
      confidence: phase.maxProbability,
    };
  }
}

function concat(left: Int16Array, right: Int16Array): Int16Array {
  const merged = new Int16Array(left.length + right.length);
  merged.set(left);
  merged.set(right, left.length);
  return merged;
}

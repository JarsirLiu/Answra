import { describe, expect, it } from "vitest";
import {
  type AudioSegment,
  PCM_FRAME_MAX_SAMPLES,
  type SpeechActivityEvent,
  utteranceId,
} from "../../../src/interview/contracts";
import { VAD_CHUNK_OVERLAP_SAMPLES, VAD_MAX_GAP_FRAMES } from "../../../src/interview/vad/config";
import { VadSegmenter } from "../../../src/interview/vad/segmenter";
import {
  loudSpeechValue,
  makeFrame,
  makePcmBytes,
  TEST_FRAME_SAMPLES,
  TEST_SESSION,
} from "./fixtures";

interface FrameSpec {
  activity?: SpeechActivityEvent[];
  startSample?: number;
}

/** 预卷一段带低谷的波形：样本 [40_000, 41_600) 幅值 10，其余为标准响度语音。 */
function softDipValue(sample: number): number {
  if (sample >= 40_000 && sample < 41_600) return 10;
  return loudSpeechValue(sample);
}

function started(utterance: string, atSample: number): SpeechActivityEvent {
  return {
    type: "speech-started",
    sessionId: TEST_SESSION,
    source: "interviewer",
    utteranceId: utteranceId(utterance),
    atSample,
    confidence: 0.9,
  };
}

function ended(utterance: string, atSample: number): SpeechActivityEvent {
  return {
    type: "speech-ended",
    sessionId: TEST_SESSION,
    source: "interviewer",
    utteranceId: utteranceId(utterance),
    atSample,
    confidence: 0.9,
  };
}

function buildSegmenter(): {
  segmenter: VadSegmenter;
  feed: (specs: readonly FrameSpec[]) => AudioSegment[];
} {
  const segmenter = new VadSegmenter(TEST_SESSION, "interviewer");
  const feed = (specs: readonly FrameSpec[]): AudioSegment[] => {
    const segments: AudioSegment[] = [];
    specs.forEach((spec, sequence) => {
      const frame = makeFrame(
        "interviewer",
        sequence,
        TEST_FRAME_SAMPLES,
        softDipValue,
        spec.startSample,
      );
      segments.push(...segmenter.pushFrame(frame, spec.activity ?? []));
    });
    return segments;
  };
  return { segmenter, feed };
}

describe("vad segmenter folding frames and activity into segments", () => {
  it("opens chunks from the ring window and closes the utterance slice at the ended sample", () => {
    const { feed } = buildSegmenter();
    const segments = feed([
      { activity: [started("interviewer-1", 1_024)] },
      { activity: [ended("interviewer-1", 1_536)] },
    ]);

    expect(segments).toHaveLength(1);
    const segment = segments[0]!;
    expect(segment).toMatchObject({
      sessionId: "capture-1",
      source: "interviewer",
      boundary: "utterance-end",
      chunkIndex: 0,
      startSample: 0,
      endSample: TEST_FRAME_SAMPLES,
    });
    expect(String(segment.utteranceId)).toBe("interviewer-1");
    expect(segment.pcm).toEqual(makePcmBytes(TEST_FRAME_SAMPLES, softDipValue, 0));
  });

  it("caps the chunk start at the ring window when speech onsets beyond the pre-roll budget", () => {
    // 环形缓冲容量 = 300ms = 4_800 样本。前 6 帧纯静默回放后 ring 只保留
    // [5_952, 10_752)；started 回溯 4_800 也早于 ring 起点，chunk 只能从
    // ring 起点开，不得丢字头也不得越界取 ring。
    const { feed } = buildSegmenter();
    const segments = feed([
      ...Array.from({ length: 6 }, (): FrameSpec => ({})),
      { activity: [started("interviewer-1", 9_728)] },
      { activity: [ended("interviewer-1", 10_752)] },
    ]);

    expect(segments).toHaveLength(1);
    const segment = segments[0]!;
    expect(segment).toMatchObject({ startSample: 5_952, endSample: 10_752 });
    expect(segment.pcm).toEqual(makePcmBytes(4_800, loudSpeechValue, 5_952));
  });

  it("force-splits at the lowest-RMS window with a one-frame continuation overlap", () => {
    const { feed } = buildSegmenter();
    // 48 帧后 open chunk 达 73_728 样本 ≥ 4.5s（72_000），在唯一低谷窗中心强切。
    const segments = feed([
      { activity: [started("interviewer-1", 1_024)] },
      ...Array.from({ length: 47 }, (): FrameSpec => ({})),
      {},
      { activity: [ended("interviewer-1", 40_960)] },
    ]);

    expect(segments).toHaveLength(2);
    const [first, second] = segments;
    expect(first).toMatchObject({
      boundary: "continuation",
      chunkIndex: 0,
      startSample: 0,
      endSample: 40_080,
    });
    expect(first?.pcm).toEqual(makePcmBytes(40_080, softDipValue, 0));
    expect(second).toMatchObject({
      boundary: "utterance-end",
      chunkIndex: 1,
      startSample: 40_080 - VAD_CHUNK_OVERLAP_SAMPLES,
      endSample: 40_960,
    });
    expect(second?.pcm).toEqual(
      makePcmBytes(
        40_960 - (40_080 - VAD_CHUNK_OVERLAP_SAMPLES),
        softDipValue,
        40_080 - VAD_CHUNK_OVERLAP_SAMPLES,
      ),
    );
    // 后继 chunk 头部必须完整重放前一段的切窗（重叠 = VAD_CHUNK_OVERLAP_SAMPLES
    // = 1 帧基准 1_600 样本），供转录按稳定范围去重。
    expect(second?.pcm.subarray(0, VAD_CHUNK_OVERLAP_SAMPLES * 2)).toEqual(
      first?.pcm.subarray((first?.pcm.length ?? 0) - VAD_CHUNK_OVERLAP_SAMPLES * 2),
    );
  });

  it("carries the post-cut tail forward and only cuts after the previous cut window", () => {
    // 低谷收窄为单个 RMS 窗 [40_000..40_160)。第一刀落在低谷中心 40_080；
    // 若无防环下限，第二刀会在重叠区里再次选中同一个低谷窗口（永远切 40_080），
    // chunk 不推进；正确行为是第二刀落在低谷之后的第一个窗口 40_160。
    const narrowDipValue = (sample: number): number =>
      sample >= 40_000 && sample < 40_160 ? 10 : loudSpeechValue(sample);
    const megaFrames = Array.from({ length: 71 }, (): FrameSpec => ({}));
    const { feed } = buildSegmenter();
    const segments = feed([{ activity: [started("interviewer-1", 1_024)] }, ...megaFrames]);

    // 第一刀：chunk[0..73_728) 在 40_080 处闭合，chunkIndex 1
    const [first, second] = segments;
    expect(first).toMatchObject({
      boundary: "continuation",
      chunkIndex: 0,
      startSample: 0,
      endSample: 40_080,
    });

    // 第二刀：chunk[38_480..) 在 40_160 关闭，低谷 [40_000..40_160) 完整保留在段内
    expect(second).toMatchObject({
      boundary: "continuation",
      chunkIndex: 1,
      startSample: 40_080 - VAD_CHUNK_OVERLAP_SAMPLES,
      endSample: 40_160,
    });
    expect(second?.pcm).toEqual(
      makePcmBytes(1_680, narrowDipValue, 40_080 - VAD_CHUNK_OVERLAP_SAMPLES),
    );
    // 两刀的重叠区完全重放，且 [cut1..cut2) 的流区间只在第二段内出现一次。
    expect(second?.pcm.subarray(0, VAD_CHUNK_OVERLAP_SAMPLES * 2)).toEqual(
      first?.pcm.subarray((first?.pcm.length ?? 0) - VAD_CHUNK_OVERLAP_SAMPLES * 2),
    );
  });

  it("pads a mendable stream gap with silence and keeps the slice range aligned to samples", () => {
    const { feed } = buildSegmenter();
    const gapValueAt = (sample: number): number =>
      sample >= TEST_FRAME_SAMPLES && sample < 3_136 ? 0 : loudSpeechValue(sample);
    const segments = feed([
      { activity: [started("interviewer-1", 1_024)] },
      { startSample: 3_136 },
      { activity: [ended("interviewer-1", 3_840)] },
    ]);

    expect(segments).toHaveLength(1);
    const segment = segments[0]!;
    expect(segment).toMatchObject({ startSample: 0, endSample: 3_840 });
    expect(segment.pcm).toEqual(makePcmBytes(3_840, gapValueAt, 0));
  });

  it("fails closed on a torn stream beyond the mendable gap budget", () => {
    const { feed } = buildSegmenter();
    feed([{}]);

    const torn = {
      startSample: TEST_FRAME_SAMPLES + VAD_MAX_GAP_FRAMES * PCM_FRAME_MAX_SAMPLES + 1,
    };
    expect(() => feed([torn])).toThrowError("音频撕裂超出可补范围：12801 样本");
  });

  it("ignores a stray speech-ended event when no chunk is open", () => {
    const { feed } = buildSegmenter();
    const segments = feed([{}, { activity: [ended("interviewer-0", 256)] }]);

    expect(segments).toHaveLength(0);
  });

  it("rejects speech-started while the previous utterance is still open", () => {
    const { feed } = buildSegmenter();
    feed([{ activity: [started("interviewer-1", 1_024)] }]);

    expect(() => feed([{ activity: [started("interviewer-2", 2_048)] }])).toThrowError(
      "检测器在上一个 utterance 闭合前又发出 speech-started",
    );
  });

  it("flush closes the tail utterance and clears the segmenter state", () => {
    const { segmenter, feed } = buildSegmenter();
    feed([{ activity: [started("interviewer-1", 1_024)] }]);

    const flushed = segmenter.flush(TEST_SESSION, "interviewer");
    expect(flushed).toHaveLength(1);
    const segment = flushed[0]!;
    expect(segment).toMatchObject({
      boundary: "utterance-end",
      startSample: 0,
      endSample: TEST_FRAME_SAMPLES,
    });
    expect(segment.pcm).toEqual(makePcmBytes(TEST_FRAME_SAMPLES, softDipValue, 0));

    expect(segmenter.flush(TEST_SESSION, "interviewer")).toHaveLength(0);
    feed([{}]);
    expect(segmenter.flush(TEST_SESSION, "interviewer")).toHaveLength(0);
  });

  it("reset discards the open chunk and ring so later events produce nothing", () => {
    const { segmenter, feed } = buildSegmenter();
    feed([{ activity: [started("interviewer-1", 1_024)] }]);

    segmenter.reset(TEST_SESSION, "interviewer");

    feed([{ activity: [ended("interviewer-1", 2_048)] }]);
    expect(segmenter.flush(TEST_SESSION, "interviewer")).toHaveLength(0);
  });
});

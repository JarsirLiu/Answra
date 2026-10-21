// eot-bench 基线评测：真实 VAD/分段器 + 生产 Paraformer adapter。
// 核心输出是自然 turn-end 准确性、音频时间轴检测延迟和逐段 ASR 解码延迟；CER 仅供诊断。
// 由 ANSWRA_EOT_BENCH_RUN=1 门控：仅基线研究用，不进常规 CI。
// 数据由 fetch-eot-bench.mjs 下载并做 SHA 校验（data/eot-bench-zh/，gitignore）。

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AudioSegment,
  conversationId,
  createTenVadEngine,
  InterviewAudioIngress,
  InterviewVadPipeline,
  LocalParaformerAdapter,
  type OfflineRecognizerModule,
  type PcmFrame,
  sessionId,
  VAD_CLOSE_SILENCE_MS,
} from "@answra/agent/evaluation";
import { describe, expect, it } from "vitest";
import { scoreTurnEnds } from "./eot-bench-metrics";

const evalRun = String(process.env.ANSWRA_EOT_BENCH_RUN ?? "") === "1";
const evalDir = process.env.ANSWRA_ASR_EVAL_DIR
  ? path.resolve(String(process.env.ANSWRA_ASR_EVAL_DIR))
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(evalDir, "..", "..");
const dataRoot = path.join(evalDir, "data", "eot-bench-zh");
const MODEL_ID = "paraformer-zh-small-int8";
const EVAL_FRAME_SAMPLES = 1_536;

interface ManifestFile {
  url: string;
  bytes: number;
  sha256: string;
}
interface Manifest {
  models: Record<string, { asr: string; runs: { files: Record<string, ManifestFile> }[] }>;
}
const manifest = JSON.parse(
  readFileSync(path.join(evalDir, "assets.manifest.json"), "utf8"),
) as Manifest;

interface TurnSpan {
  start: number;
  end: number;
}
interface Turn {
  id: string;
  duration: number;
  silenceSpans: TurnSpan[];
  words: { start: number; end: number; word: string }[];
  messages: { role: string; content: string | null }[];
}

function normalize(text: string): string {
  return text.replace(/<\|[^|]*\|>/g, "").replace(/[^\p{L}\p{N}]/gu, "");
}

function editDistance(ref: string, hyp: string): number {
  const refChars = Array.from(ref);
  const hypChars = Array.from(hyp);
  let prev = hypChars.map((_, i) => i);
  prev.push(hypChars.length);
  for (let r = 1; r <= refChars.length; r += 1) {
    const curr = new Array(hypChars.length + 1).fill(0);
    curr[0] = r;
    for (let h = 1; h <= hypChars.length; h += 1) {
      const substitution = prev[h - 1] + (refChars[r - 1] === hypChars[h - 1] ? 0 : 1);
      curr[h] = Math.min(prev[h] + 1, curr[h - 1] + 1, substitution);
    }
    prev = curr;
  }
  return prev[hypChars.length];
}

function readWav16(file: string): { samples: Float32Array; sampleRate: number } {
  const buf = readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE")
    throw new Error(`非 RIFF/WAVE: ${file}`);
  let offset = 12;
  let fmt:
    | { sampleRate: number; numChannels: number; audioFormat: number; bitsPerSample: number }
    | undefined;
  let data: Uint8Array | undefined;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "fmt ")
      fmt = {
        sampleRate: buf.readUInt32LE(offset + 12),
        numChannels: buf.readUInt16LE(offset + 10),
        audioFormat: buf.readUInt16LE(offset + 8),
        bitsPerSample: buf.readUInt16LE(offset + 22),
      };
    else if (chunkId === "data") data = buf.subarray(offset + 8, offset + 8 + chunkSize);
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (!fmt || !data || fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16)
    throw new Error(`音频格式不支持: ${file}`);
  const samples = new Float32Array(Math.floor(data.length / 2 / fmt.numChannels));
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < samples.length; i += 1) {
    let acc = 0;
    for (let c = 0; c < fmt.numChannels; c += 1)
      acc += view.getInt16((i * fmt.numChannels + c) * 2, true);
    samples[i] = acc / fmt.numChannels / 32768;
  }
  return { samples, sampleRate: fmt.sampleRate };
}

function sha256File(file: string): string {
  const SIZE = 4 * 1024 * 1024;
  const buf = Buffer.alloc(SIZE);
  const fd = openSync(file, "r");
  try {
    const hash = createHash("sha256");
    for (;;) {
      const read = readSync(fd, buf, 0, SIZE, null);
      if (read <= 0) break;
      hash.update(read === SIZE ? buf : buf.subarray(0, read));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

function csvField(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// 标注边界与检测器 speech-end 时间戳存在偏移，允许半秒匹配误差。
const SPAN_MATCH_TOLERANCE_MS = 500;

type TurnOutcome = {
  id: string;
  referenceText: string;
  recognizedText: string;
  refChars: number;
  hypChars: number;
  errs: number;
  segments: number;
  asrDecodeMs: number[];
  segmentDecoded: boolean[];
  eotDetected: boolean;
  holdFalseCutoffs: number;
  eotDetectionLatencyMs: number | undefined;
  finalDecodeMs: number | undefined;
  turnReadyEstimateMs: number | undefined;
};

describe.skipIf(!evalRun)("eot-bench 真实中文轮次基线", () => {
  it("ingress 校验 → TEN VAD → segmenter → LocalParaformerAdapter，输出 out/eot-bench-*.csv", {
    timeout: 900_000,
  }, async () => {
    const requireSherpa = createRequire(import.meta.url);
    const sherpa = requireSherpa("sherpa-onnx-node") as {
      OfflineRecognizer: new (
        config: unknown,
      ) => {
        createStream: () => {
          acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
        };
        decode: (stream: unknown) => void;
        getResult: (stream: unknown) => { text: string };
      };
    };
    const outRoot = path.join(evalDir, "out");
    const vadDir = path.join(repoRoot, "apps", "desktop", "resources", "vad");
    for (const file of ["ten_vad.js", "ten_vad.wasm"])
      expect(existsSync(path.join(vadDir, file))).toBe(true);

    const turns: Turn[] = JSON.parse(readFileSync(path.join(dataRoot, "turns.json"), "utf8"));
    expect(turns.length).toBeGreaterThan(0);

    const glueSource = readFileSync(path.join(vadDir, "ten_vad.js"), "utf8");
    const wasmBinary = readFileSync(path.join(vadDir, "ten_vad.wasm"));
    const engine = await createTenVadEngine({ glueSource, wasmBinary });
    let failureCode = "";
    const pipeline = new InterviewVadPipeline({
      vad: { load: async () => engine },
      failSession: (_id, code) => {
        failureCode = code;
      },
    });

    const model = manifest.models[MODEL_ID];
    const runFiles = model.runs[0]?.files;
    const modelPath = path.join(evalDir, "models", MODEL_ID, "model.int8.onnx");
    if (sha256File(modelPath) !== runFiles["model.int8.onnx"].sha256)
      throw new Error(`模型 ${MODEL_ID} SHA 不匹配：重跑 fetch-assets.mjs`);
    function sherpaModule(): OfflineRecognizerModule {
      return {
        create: (recipe) => {
          const recognizer = new sherpa.OfflineRecognizer({
            modelConfig: {
              paraformer: { model: recipe.modelPath },
              tokens: recipe.tokensPath,
              numThreads: recipe.numThreads,
              debug: 0,
              provider: "cpu",
            },
          });
          return {
            transcribeOnce: ({ samples, sampleRate }) => {
              const stream = recognizer.createStream();
              stream.acceptWaveform({ samples, sampleRate });
              recognizer.decode(stream);
              return recognizer.getResult(stream).text;
            },
          };
        },
      };
    }
    const adapter = new LocalParaformerAdapter({
      module: sherpaModule(),
      recipe: {
        modelPath,
        tokensPath: path.join(evalDir, "models", MODEL_ID, "tokens.txt"),
        numThreads: 4,
      },
    });

    const outcomes: TurnOutcome[] = [];
    let vadMsTotal = 0;
    let streamSecTotal = 0;

    for (const turn of turns) {
      const wav = path.join(dataRoot, "audio", `${turn.id}.wav`);
      const { samples, sampleRate } = readWav16(wav);
      expect(sampleRate).toBe(16_000);
      const session = sessionId(`eot-${turn.id}`);
      const conversation = conversationId(`eot-conv-${turn.id}`);
      const ingress = new InterviewAudioIngress({
        emit: () => {},
        onFrame: (frame) => pipeline.handleFrame(frame),
      });
      await pipeline.start(session);
      ingress.start(session, conversation);
      expect(ingress.captureReady(session)).toBe(true);

      let frameCount = 0;
      let sampleCursor = 0;
      const segmentAvailableSample = new Map<AudioSegment, number>();
      const observedSegments: AudioSegment[] = [];
      while (sampleCursor < samples.length) {
        const take = Math.min(EVAL_FRAME_SAMPLES, samples.length - sampleCursor);
        const pcm = new Uint8Array(take * 2);
        const view = new DataView(pcm.buffer);
        for (let i = 0; i < take; i += 1)
          view.setInt16(
            i * 2,
            Math.max(-32768, Math.min(32767, Math.round(samples[sampleCursor + i] * 32768))),
            true,
          );
        const frame: PcmFrame = {
          sessionId: session,
          source: "interviewer",
          sequence: frameCount,
          startSample: sampleCursor,
          sampleRate,
          channels: 1,
          encoding: "pcm_s16le",
          pcm,
        };
        const t0 = performance.now();
        const ingestResult = ingress.acceptFrame(frame);
        vadMsTotal += performance.now() - t0;
        expect(ingestResult.accepted).toBe(true);
        const staged = pipeline.stagedSegments(session);
        const availableSample = sampleCursor + take;
        for (const segment of staged) {
          if (!segmentAvailableSample.has(segment)) {
            segmentAvailableSample.set(segment, availableSample);
            observedSegments.push(segment);
          }
        }
        sampleCursor += take;
        frameCount += 1;
      }
      streamSecTotal += samples.length / sampleRate;
      const naturalSegments = observedSegments;
      const segments = naturalSegments;
      expect(ingress.stop(session)).toBe(true);
      pipeline.stop(session);

      // ASR：逐段解码，按时间序拼接为整轮 hyp，参考为样本 words 拼接。
      const referenceText = turn.words.map((w) => w.word).join("");
      const ref = normalize(referenceText);
      const decodeMs: number[] = [];
      const asrDecodeMs: number[] = [];
      const segmentDecoded: boolean[] = [];
      const hypParts: string[] = [];
      for (const segment of segments) {
        const t0 = performance.now();
        const events = await adapter.transcribe(segment, new AbortController().signal);
        decodeMs.push(performance.now() - t0);
        const errorEvent = events.find((e) => e.kind === "error");
        if (errorEvent) throw new Error(`engine error ${errorEvent.code}: ${turn.id}`);
        const finalEvent = events.find((e) => e.kind === "chunk-final");
        segmentDecoded.push(finalEvent !== undefined);
        if (finalEvent) asrDecodeMs.push(decodeMs.at(-1) ?? 0);
        hypParts.push(finalEvent?.text ?? "");
      }
      const recognizedText = hypParts.join("");
      const hyp = normalize(recognizedText);

      // Only segments staged during frame delivery count; stop-time flush is not an online detection.
      const observations = naturalSegments.flatMap((segment) => {
        if (segment.boundary !== "utterance-end") return [];
        const observedSample = segmentAvailableSample.get(segment);
        if (observedSample === undefined)
          throw new Error(`缺少在线观察时间: ${turn.id}/${segment.utteranceId}`);
        return [{ endSample: segment.endSample, observedSample }];
      });
      const turnScore = scoreTurnEnds(
        observations,
        turn.silenceSpans,
        sampleRate,
        SPAN_MATCH_TOLERANCE_MS,
      );
      const finalSegmentIndex = segments.findLastIndex(
        (segment) => segment.boundary === "utterance-end",
      );
      const finalDecodeMs =
        finalSegmentIndex >= 0 && segmentDecoded[finalSegmentIndex]
          ? (decodeMs[finalSegmentIndex] ?? 0)
          : undefined;
      const turnReadyEstimateMs =
        turnScore.eotDetectionLatencyMs === undefined || finalDecodeMs === undefined
          ? undefined
          : turnScore.eotDetectionLatencyMs + finalDecodeMs;

      outcomes.push({
        id: turn.id,
        referenceText,
        recognizedText,
        refChars: Array.from(ref).length,
        hypChars: Array.from(hyp).length,
        errs: editDistance(ref, hyp),
        segments: segments.length,
        asrDecodeMs,
        segmentDecoded,
        ...turnScore,
        finalDecodeMs,
        turnReadyEstimateMs,
      });
    }

    expect(failureCode).toBe("");
    pipeline.dispose();

    const totalRef = outcomes.reduce((s, o) => s + o.refChars, 0);
    const totalErr = outcomes.reduce((s, o) => s + o.errs, 0);
    const totalHold = turns.reduce((s, t) => s + (t.silenceSpans.length - 1), 0);
    const totalFalseCutoff = outcomes.reduce((s, o) => s + o.holdFalseCutoffs, 0);
    const eotHits = outcomes.filter((o) => o.eotDetected).length;
    const eotLatencies = outcomes
      .flatMap((o) => (o.eotDetectionLatencyMs === undefined ? [] : [o.eotDetectionLatencyMs]))
      .sort((a, b) => a - b);
    const readyEstimates = outcomes
      .flatMap((o) => (o.turnReadyEstimateMs === undefined ? [] : [o.turnReadyEstimateMs]))
      .sort((a, b) => a - b);
    const allDecode = outcomes.flatMap((o) => o.asrDecodeMs).sort((a, b) => a - b);
    const totalSegments = outcomes.reduce((sum, outcome) => sum + outcome.segments, 0);
    const percentile = (values: readonly number[], ratio: number): number =>
      values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)] : 0;
    const falseTurnEnds = outcomes.reduce((sum, outcome) => sum + outcome.falseTurnEnds, 0);
    const eotPrecision = eotHits + falseTurnEnds === 0 ? 0 : eotHits / (eotHits + falseTurnEnds);
    const eotRecall = eotHits / outcomes.length;
    const eotF1 =
      eotPrecision + eotRecall === 0
        ? 0
        : (2 * eotPrecision * eotRecall) / (eotPrecision + eotRecall);

    const resultHeader =
      "turn_id,eot_detected,eot_detection_latency_ms,hold_false_cutoffs,segments,final_segment_decoded,final_decode_ms,turn_ready_estimate_ms,cer_pct_diagnostic,reference_text,recognized_text,review_should_reply,review_semantic_complete,review_model_input_acceptable,review_notes";
    const resultLines = [resultHeader];
    for (const o of outcomes)
      resultLines.push(
        [
          o.id,
          o.eotDetected ? 1 : 0,
          o.eotDetectionLatencyMs ?? "",
          o.holdFalseCutoffs,
          o.segments,
          o.finalDecodeMs === undefined ? 0 : 1,
          o.finalDecodeMs ?? "",
          o.turnReadyEstimateMs ?? "",
          o.refChars ? ((o.errs / o.refChars) * 100).toFixed(2) : "",
          o.referenceText,
          o.recognizedText,
          "",
          "",
          "",
          "",
        ]
          .map(csvField)
          .join(","),
      );

    const summary = [
      `turns,${outcomes.length}`,
      `eot_true_positives,${eotHits}`,
      `eot_false_positives,${falseTurnEnds}`,
      `eot_precision_pct,${(eotPrecision * 100).toFixed(2)}`,
      `eot_recall_pct,${(eotRecall * 100).toFixed(2)}`,
      `eot_f1_pct,${(eotF1 * 100).toFixed(2)}`,
      `hold_spans,${totalHold}`,
      `hold_false_cutoffs,${totalFalseCutoff}`,
      `hold_false_cutoff_rate_pct,${totalHold ? ((totalFalseCutoff / totalHold) * 100).toFixed(2) : ""}`,
      `eot_detection_latency_p50_ms,${percentile(eotLatencies, 0.5)}`,
      `eot_detection_latency_p95_ms,${percentile(eotLatencies, 0.95)}`,
      `turn_ready_estimates,${readyEstimates.length}`,
      `turn_ready_coverage_pct,${((readyEstimates.length / outcomes.length) * 100).toFixed(2)}`,
      `turn_ready_estimate_p50_ms,${percentile(readyEstimates, 0.5)}`,
      `turn_ready_estimate_p95_ms,${percentile(readyEstimates, 0.95)}`,
      `asr_decode_p50_ms,${percentile(allDecode, 0.5)}`,
      `asr_decode_p95_ms,${percentile(allDecode, 0.95)}`,
      `asr_decode_max_ms,${allDecode.length ? Math.round(allDecode[allDecode.length - 1]) : 0}`,
      `asr_decoded_segments,${allDecode.length}`,
      `asr_skipped_segments,${totalSegments - allDecode.length}`,
      `segments,${totalSegments}`,
      `stream_s,${streamSecTotal.toFixed(1)}`,
      `vad_rtf,${(vadMsTotal / (streamSecTotal * 1000)).toFixed(5)}`,
      `cer_pct_diagnostic,${totalRef ? ((totalErr / totalRef) * 100).toFixed(2) : ""}`,
      `close_ms,${VAD_CLOSE_SILENCE_MS}`,
    ].join("\n");

    mkdirSync(outRoot, { recursive: true });
    writeFileSync(
      path.join(outRoot, "eot-bench-results.csv"),
      `${resultLines.join("\n")}\n`,
      "utf8",
    );
    writeFileSync(path.join(outRoot, "eot-bench-summary.csv"), `${summary}\n`, "utf8");

    console.log("\n[eot-bench] 基线汇总：");
    console.log(summary);
  });
});

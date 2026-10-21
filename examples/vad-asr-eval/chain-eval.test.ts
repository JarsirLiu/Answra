// VAD+ASR 端到端评测：真实 InterviewAudioIngress（含 PcmFrameValidator）→ 真实 TEN
// VAD 预编译件 → repo 真实 SpeechActivityDetector/VadSegmenter（经
// InterviewVadPipeline 组合）→ LocalParaformerAdapter（生产 adapter，引擎经端口注入
// 为真实 sherpa-onnx addon + manifest 固定的 int8 模型）逐段解码，输出 CSV。
// 由 ANSWRA_ASR_EVAL_RUN=1 门控（run-eval.mjs 拉起），其余场景恒 skip。
// 资产由 fetch-assets.mjs 预先下载并做 SHA 校验；只支持 manifest asr=paraformer 的模型。

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
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

const evalRun = String(process.env.ANSWRA_ASR_EVAL_RUN ?? "") === "1";
const evalDir = process.env.ANSWRA_ASR_EVAL_DIR
  ? path.resolve(String(process.env.ANSWRA_ASR_EVAL_DIR))
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(evalDir, "..", "..");
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

const aliasToId = {
  small: "paraformer-zh-small-int8",
  large: "paraformer-zh-large-int8",
  sense: "sensevoice-small-int8",
} as const;
type ModelAlias = keyof typeof aliasToId;
const requestedModels = (() => {
  const raw = String(process.env.ANSWRA_ASR_EVAL_MODELS ?? "small,sense");
  const out: string[] = [];
  for (const piece of raw.split(/[,\s]+/).filter(Boolean)) {
    // 词条既允许别名（small/sense/large）也允许 manifest 全 id，统一收敛成 manifest id。
    const id = aliasToId[piece.trim() as ModelAlias] ?? piece.trim();
    if (!manifest.models[id]) throw new Error(`ANSWRA_ASR_EVAL_MODELS 无词条目 ${piece}`);
    out.push(id);
  }
  return out;
})();

function normalize(text: string): string {
  return text.replace(/<\|[^>]*\|>/g, "").replace(/[^\p{L}\p{N}]/gu, "");
}

function editDistance(ref: string, hyp: string): number {
  const refChars = Array.from(ref);
  const hypChars = Array.from(hyp);
  let prev = hypChars.map((_, i) => i);
  prev.push(hypChars.length);
  let curr = new Array(hypChars.length + 1).fill(0);
  for (let r = 1; r <= refChars.length; r += 1) {
    curr = new Array(hypChars.length + 1).fill(0);
    curr[0] = r;
    for (let h = 1; h <= hypChars.length; h += 1) {
      const substitution = prev[h - 1] + (refChars[r - 1] === hypChars[h - 1] ? 0 : 1);
      curr[h] = Math.min(prev[h] + 1, curr[h - 1] + 1, substitution);
    }
    prev = curr;
  }
  return prev[hypChars.length];
}

type ClipRef = { id: string; ref: string; samples: Float32Array };

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
    for (let c = 0; c < fmt.numChannels; c += 1) {
      acc += view.getInt16((i * fmt.numChannels + c) * 2, true);
    }
    samples[i] = acc / fmt.numChannels / 32768;
  }
  return { samples, sampleRate: fmt.sampleRate };
}

function pickClips(dataRoot: string, count: number): ClipRef[] {
  const refs = new Map<string, string>();
  for (const line of readFileSync(path.join(dataRoot, "aishell_transcript_v0.8.txt"), "utf8").split(
    /\r?\n/,
  )) {
    const idx = line.indexOf(" ");
    if (idx <= 0) continue;
    refs.set(line.slice(0, idx).trim(), normalize(line.slice(idx + 1)));
  }
  const dir = path.join(dataRoot, "train", "S0002");
  const clips: ClipRef[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (clips.length >= count) break;
    if (!file.endsWith(".wav")) continue;
    const id = file.slice(0, -4);
    const ref = refs.get(id);
    if (!ref || ref.includes("unk") || ref.length < 8 || ref.length > 40) continue;
    const { samples, sampleRate } = readWav16(path.join(dir, file));
    const seconds = samples.length / sampleRate;
    if (seconds < 4 || seconds > 8) continue;
    clips.push({ id, ref, samples });
  }
  return clips;
}

function csvField(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// 文件级流式 SHA-256（模型文件大，不能整读内存）。
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

type SherpaStream = { acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void };
type SherpaRecognizer = {
  createStream: () => SherpaStream;
  decode: (stream: SherpaStream) => void;
  getResult: (stream: SherpaStream) => { text: string };
};
type SherpaModule = {
  OfflineRecognizer: new (config: unknown) => SherpaRecognizer;
};

// 文件级流式 SHA-256（模型文件大，不能整读内存）。

describe.skipIf(!evalRun)("VAD+ASR 端到端评测", () => {
  it("真实链路：ingress 校验 → TEN VAD → segmenter → LocalParaformerAdapter，输出 out/results.csv + out/summary.csv", {
    timeout: 900_000,
  }, async () => {
    const requireSherpa = createRequire(import.meta.url);
    const sherpa = requireSherpa("sherpa-onnx-node") as SherpaModule;
    const dataRoot = path.join(evalDir, "data");
    const outRoot = path.join(evalDir, "out");
    const vadDir = path.join(repoRoot, "apps", "desktop", "resources", "vad");
    for (const file of ["ten_vad.js", "ten_vad.wasm"])
      expect(existsSync(path.join(vadDir, file))).toBe(true);

    const clips = pickClips(dataRoot, 10);
    expect(clips.length).toBeGreaterThanOrEqual(8);

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
    const session = sessionId("asr-eval");
    const source = "interviewer" as const;
    const conversation = conversationId("asr-eval-conv");
    // 真实采集入口链：帧先过 ingress（未信任输入校验 + 连续性/gap 追踪）再进 VAD。
    const ingress = new InterviewAudioIngress({
      emit: () => {},
      onFrame: (frame) => pipeline.handleFrame(frame),
    });
    await pipeline.start(session);
    ingress.start(session, conversation);
    expect(ingress.captureReady(session)).toBe(true);

    const silenceSec = 0.85;
    const spans: { startSec: number; endSec: number; clipIndex: number }[] = [];
    let cursor = 0;
    for (const [index, clip] of clips.entries()) {
      spans.push({
        startSec: cursor,
        endSec: cursor + clip.samples.length / 16_000,
        clipIndex: index,
      });
      cursor += clip.samples.length / 16_000 + silenceSec;
    }
    const totalSamples = Math.floor(cursor * 16_000);
    const pcmBytes = new Uint8Array(totalSamples * 2);
    const dataView = new DataView(pcmBytes.buffer);
    for (const span of spans) {
      const clip = clips[span.clipIndex];
      const base = Math.floor(span.startSec * 16_000);
      for (let i = 0; i < clip.samples.length; i += 1) {
        dataView.setInt16(
          (base + i) * 2,
          Math.max(-32768, Math.min(32767, Math.round(clip.samples[i] * 32768))),
          true,
        );
      }
    }

    let vadMsTotal = 0;
    let frameCount = 0;
    let sampleCursor = 0;
    while (sampleCursor < totalSamples) {
      const take = Math.min(EVAL_FRAME_SAMPLES, totalSamples - sampleCursor);
      const frame: PcmFrame = {
        sessionId: session,
        source,
        sequence: frameCount,
        startSample: sampleCursor,
        sampleRate: 16_000,
        channels: 1,
        encoding: "pcm_s16le",
        pcm: pcmBytes.subarray(sampleCursor * 2, (sampleCursor + take) * 2),
      };
      const t0 = performance.now();
      const ingestResult = ingress.acceptFrame(frame);
      vadMsTotal += performance.now() - t0;
      expect(ingestResult.accepted).toBe(true);
      sampleCursor += take;
      frameCount += 1;
    }
    const streamSec = sampleCursor / 16_000;
    const segments: readonly AudioSegment[] = pipeline.stagedSegments("asr-eval");
    pipeline.stop(session);
    expect(ingress.stop(session)).toBe(true);
    expect(failureCode).toBe("");
    expect(segments.length).toBeGreaterThanOrEqual(clips.length);

    // 真实 adapter 路径：评测用的"desktop 注入站"——把评测进程里的 sherpa addon
    // 适配成 OfflineRecognizerModule（未来 desktop 侧组合根提供同形实现）。
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
            // stream 生命周期由注入侧闭合：一次整段 create→accept→decode→getResult。
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
    const providers = requestedModels.map((id) => {
      const model = manifest.models[id];
      if (model?.asr !== "paraformer")
        throw new Error(`模型 ${id} 不是 paraformer 型；adapter 链路评测只支持 paraformer 族`);
      const runFiles = model.runs[0]?.files;
      if (!runFiles?.["model.int8.onnx"] || !runFiles?.["tokens.txt"])
        throw new Error(`manifest 缺少模型 ${id}；先跑 fetch-assets.mjs`);
      const expected = runFiles["model.int8.onnx"].sha256;
      const modelPath = path.join(evalDir, "models", id, "model.int8.onnx");
      if (sha256File(modelPath) !== expected)
        throw new Error(`模型 ${id} SHA 不匹配：重跑 fetch-assets.mjs`);
      const adapter = new LocalParaformerAdapter({
        module: sherpaModule(),
        recipe: {
          modelPath,
          tokensPath: path.join(evalDir, "models", id, "tokens.txt"),
          numThreads: 4,
        },
      });
      return { id, adapter };
    });

    type Row = {
      modelId: string;
      clipId: string;
      ref: string;
      hyp: string;
      boundary: string;
      segStartS: number;
      segDurS: number;
      decodeMs: number;
    };
    const rows: Row[] = [];
    for (const segment of segments) {
      const segStart = segment.startSample / segment.sampleRate;
      const segEnd = segment.endSample / segment.sampleRate;
      let bestSpan: (typeof spans)[number] | undefined;
      let bestOverlap = 0;
      for (const span of spans) {
        const overlap = Math.min(segEnd, span.endSec) - Math.max(segStart, span.startSec);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestSpan = span;
        }
      }
      const clipRef = bestSpan ? clips[bestSpan.clipIndex].ref : "";
      const clipId = bestSpan ? clips[bestSpan.clipIndex].id : "";
      const segDurS = (segment.endSample - segment.startSample) / segment.sampleRate;
      for (const item of providers) {
        const t0 = performance.now();
        const events = await item.adapter.transcribe(segment, new AbortController().signal);
        const decodeMs = performance.now() - t0;
        const finalEvent = events.find((e) => e.kind === "chunk-final");
        const errorEvent = events.find((e) => e.kind === "error");
        if (errorEvent) throw new Error(`engine error ${errorEvent.code}: ${segDurS.toFixed(3)}s`);
        rows.push({
          modelId: item.id,
          clipId,
          ref: clipRef,
          hyp: finalEvent?.text ?? "",
          boundary: segment.boundary,
          segDurS,
          segStartS: segStart,
          decodeMs,
        });
      }
    }

    const resultHeader = "model_id,clip_id,boundary,seg_dur_s,decode_ms,cer_pct,ref_text,hyp_text";
    const resultLines: string[] = [resultHeader];
    const summary = new Map<
      string,
      { rows: Row[]; totalChars: number; totalErrors: number; skippedShort: number }
    >();
    for (const id of requestedModels)
      summary.set(id, { rows: [], totalChars: 0, totalErrors: 0, skippedShort: 0 });
    for (const row of rows) {
      const entry = summary.get(row.modelId);
      if (!entry) continue;
      entry.rows.push(row);
      const hyp = normalize(row.hyp);
      resultLines.push(
        [
          row.modelId,
          row.clipId,
          row.boundary,
          row.segDurS.toFixed(3),
          Math.round(row.decodeMs),
          row.ref
            ? (
                (editDistance(row.ref, hyp) / Math.max(1, Array.from(row.ref).length)) *
                100
              ).toFixed(2)
            : "",
          row.ref,
          hyp,
        ]
          .map(csvField)
          .join(","),
      );
    }

    // sherpa 对 <0.3s 超短段会 Reshape 异常并返回空文本（实测结论），此类强切尾巴
    // 属于噪声：results.csv 保留原样，summary 只统计有效段。
    // 另一关键口径：强切段逐段 vs 整句参考天然高错（切损首尾字按错字计），对话场景
    // 更真实的口径是把同一句话的所有切片按时间序合并再对照整句参考（utter_*）。
    const MIN_SEG_S = 0.3;
    const summaryLines: string[] = [
      "model_id,segments,short_skipped,chars,errs,seg_cer_pct,utter_clips,utter_chars,utter_errs,utter_cer_pct,mean_decode_ms,p95_decode_ms,max_decode_ms,max_seg_s,close_ms,max_ready_ms,stream_s,vad_ms,vad_rtf",
    ];
    type UtterStat = { clips: number; chars: number; errs: number };
    const utterStats = new Map<string, UtterStat>();
    for (const [id, entry] of summary) {
      const used = entry.rows.filter((r) => r.segDurS >= MIN_SEG_S);
      for (const row of entry.rows) {
        if (row.segDurS < MIN_SEG_S) entry.skippedShort += 1;
        if (row.ref && row.segDurS >= MIN_SEG_S) {
          entry.totalChars += Array.from(row.ref).length;
          entry.totalErrors += editDistance(row.ref, normalize(row.hyp));
        }
      }
      // utterance 合并口径：同 clip 有效段按 segStart 排序拼接 hyp 后对照整句。
      const stat: UtterStat = { clips: 0, chars: 0, errs: 0 };
      for (const clip of clips) {
        const parts = entry.rows
          .filter((r) => r.clipId === clip.id && r.segDurS >= MIN_SEG_S)
          .sort((a, b) => a.segStartS - b.segStartS)
          .map((r) => normalize(r.hyp))
          .filter(Boolean);
        if (parts.length === 0) continue;
        stat.clips += 1;
        stat.chars += Array.from(clip.ref).length;
        stat.errs += editDistance(clip.ref, parts.join(""));
      }
      utterStats.set(id, stat);
      const decode = used.map((r) => Math.round(r.decodeMs)).sort((a, b) => a - b);
      const mean = decode.length
        ? Math.round(decode.reduce((a, b) => a + b, 0) / decode.length)
        : 0;
      const p95 = decode.length
        ? decode[Math.min(decode.length - 1, Math.floor(decode.length * 0.95))]
        : 0;
      const max = decode.length ? decode[decode.length - 1] : 0;
      const maxSegS = used.length ? Math.max(...used.map((r) => r.segDurS)) : 0;
      const utter = utterStats.get(id) as UtterStat;
      summaryLines.push(
        [
          id,
          entry.rows.length,
          entry.skippedShort,
          entry.totalChars,
          entry.totalErrors,
          entry.totalChars ? ((entry.totalErrors / entry.totalChars) * 100).toFixed(2) : "",
          utter.clips,
          utter.chars,
          utter.errs,
          utter.chars ? ((utter.errs / utter.chars) * 100).toFixed(2) : "",
          mean,
          p95,
          max,
          maxSegS.toFixed(2),
          VAD_CLOSE_SILENCE_MS,
          Math.round(VAD_CLOSE_SILENCE_MS + max),
          streamSec.toFixed(1),
          Math.round(vadMsTotal),
          (vadMsTotal / (streamSec * 1000)).toFixed(5),
        ]
          .map(csvField)
          .join(","),
      );
    }
    mkdirSync(outRoot, { recursive: true });
    writeFileSync(path.join(outRoot, "results.csv"), `${resultLines.join("\n")}\n`, "utf8");
    writeFileSync(path.join(outRoot, "summary.csv"), `${summaryLines.join("\n")}\n`, "utf8");
  });
});

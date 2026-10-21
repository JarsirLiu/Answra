import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  conversationId,
  createTenVadEngine,
  InterviewAudioIngress,
  InterviewVadPipeline,
  type PcmFrame,
  sessionId,
} from "@answra/agent/evaluation";
import { describe, it } from "vitest";

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(evalDir, "..", "..");
const vadDir = path.join(repoRoot, "apps", "desktop", "resources", "vad");
const DEBUG_FRAME_SAMPLES = 1_536;

function readWav16(file: string): { samples: Float32Array; sampleRate: number } {
  const buf = readFileSync(file);
  let offset = 12;
  let fmt: Record<string, number> = {};
  let data: Uint8Array | undefined;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ")
      fmt = {
        sampleRate: buf.readUInt32LE(offset + 12),
        numChannels: buf.readUInt16LE(offset + 10),
        audioFormat: buf.readUInt16LE(offset + 8),
        bitsPerSample: buf.readUInt16LE(offset + 22),
      };
    else if (id === "data") data = buf.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  const samples = new Float32Array(Math.floor((data as Uint8Array).length / 2 / fmt.numChannels));
  const view = new DataView(
    (data as Uint8Array).buffer,
    (data as Uint8Array).byteOffset,
    (data as Uint8Array).byteLength,
  );
  for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(i * 2, true) / 32768;
  return { samples, sampleRate: fmt.sampleRate };
}

describe("debug pipeline", () => {
  it("zh__2262", async () => {
    const engine = await createTenVadEngine({
      glueSource: readFileSync(path.join(vadDir, "ten_vad.js"), "utf8"),
      wasmBinary: readFileSync(path.join(vadDir, "ten_vad.wasm")),
    });
    const pipeline = new InterviewVadPipeline({
      vad: { load: async () => engine },
      failSession: () => {},
    });
    const { samples } = readWav16(
      path.join(evalDir, "data", "eot-bench-zh", "audio", "zh__2262.wav"),
    );
    const session = sessionId("dbg-zh2262");
    const conversation = conversationId("dbg-conv");
    const ingress = new InterviewAudioIngress({
      emit: () => {},
      onFrame: (f) => pipeline.handleFrame(f),
    });
    await pipeline.start(session);
    ingress.start(session, conversation);
    const ready = ingress.captureReady(session);
    console.log(`captureReady=${ready}`);
    let cursor = 0;
    let seq = 0;
    while (cursor < samples.length) {
      const take = Math.min(DEBUG_FRAME_SAMPLES, samples.length - cursor);
      const pcm = new Uint8Array(take * 2);
      const view = new DataView(pcm.buffer);
      for (let i = 0; i < take; i += 1)
        view.setInt16(
          i * 2,
          Math.max(-32768, Math.min(32767, Math.round(samples[cursor + i] * 32768))),
          true,
        );
      const frame: PcmFrame = {
        sessionId: session,
        source: "interviewer",
        sequence: seq++,
        startSample: cursor,
        sampleRate: 16000,
        channels: 1,
        encoding: "pcm_s16le",
        pcm,
      };
      ingress.acceptFrame(frame);
      cursor += take;
    }
    const segments = pipeline.stagedSegments(session);
    console.log(`segments=${segments.length}`);
    for (const s of segments)
      console.log(
        `${s.boundary} idx=${s.chunkIndex} ${(s.startSample / 16000).toFixed(2)}-${(s.endSample / 16000).toFixed(2)} dur=${((s.endSample - s.startSample) / 16000).toFixed(2)}`,
      );
    pipeline.stop(session);
  });
});

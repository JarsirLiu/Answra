import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEN_VAD_ONSET_THRESHOLD } from "@answra/agent";
import { createTenVadEngine } from "@answra/agent/evaluation";
import { describe, it } from "vitest";

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(evalDir, "..", "..");
const vadDir = path.join(repoRoot, "apps", "desktop", "resources", "vad");

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

describe("debug vad", () => {
  it("zh__2262", async () => {
    const engine = await createTenVadEngine({
      glueSource: readFileSync(path.join(vadDir, "ten_vad.js"), "utf8"),
      wasmBinary: readFileSync(path.join(vadDir, "ten_vad.wasm")),
    });
    const hop = engine.createHop(TEN_VAD_ONSET_THRESHOLD);
    const { samples } = readWav16(
      path.join(evalDir, "data", "eot-bench-zh", "audio", "zh__2262.wav"),
    );
    const HOP = 256;
    const flags: string[] = [];
    for (let i = 0; i + HOP <= samples.length; i += HOP) {
      const chunk = new Int16Array(HOP);
      for (let j = 0; j < HOP; j += 1)
        chunk[j] = Math.max(-32768, Math.min(32767, Math.round(samples[i + j] * 32768)));
      const r = hop.processHop(chunk);
      flags.push(`${(i / 16000).toFixed(2)}:${r.probability.toFixed(2)}${r.voiced ? "S" : "."}`);
    }
    console.log(flags.join(" "));
    const speechHops = flags.filter((f) => f.endsWith("S")).length;
    console.log(
      `speech hops: ${speechHops}/${flags.length} = ${((speechHops / flags.length) * 100).toFixed(1)}%`,
    );
    engine.destroyHop(hop);
  });
});

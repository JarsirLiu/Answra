import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(appDir, "dist");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await build({
  entryPoints: [path.join(appDir, "src/conversationRuntime.ts")],
  outfile: path.join(outDir, "runtime.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20.9",
  packages: "bundle",
  sourcemap: false,
});

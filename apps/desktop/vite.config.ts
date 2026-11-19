import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { featureDefines } from "./release-features.mjs";
import { createRendererGraphAudit } from "./scripts/renderer-graph-audit";
import { readViteReleaseConfig } from "./scripts/vite-release-config";

const profileDecisions = await readViteReleaseConfig();

export default defineConfig(({ mode }) => {
  if (!Object.hasOwn(profileDecisions, mode)) {
    throw new Error(`必须使用已登记的构建 Profile 启动 Vite：${mode}`);
  }
  const decision = profileDecisions[mode];
  if (!decision) throw new Error(`必须使用已登记的构建 Profile 启动 Vite：${mode}`);
  const features = decision.include;
  const manifest = { schemaVersion: 2, profile: mode, features };
  const define: Record<string, string> = {
    ...featureDefines(features),
    __ANSWRA_RELEASE_MANIFEST__: JSON.stringify(JSON.stringify(manifest)),
  };
  const rendererGraphAudit: Plugin = createRendererGraphAudit(mode);
  return {
    base: "./",
    plugins: [react(), rendererGraphAudit],
    define,
    build: {
      minify: "esbuild",
      sourcemap: false,
      manifest: true,
    },
  };
});

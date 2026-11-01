import type { FeatureId, ReleaseProfile } from "@answra/shared";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { createRendererGraphAudit } from "./scripts/renderer-graph-audit";
import { readViteReleaseConfig } from "./scripts/vite-release-config";

const profileDecisions = await readViteReleaseConfig();

export default defineConfig(({ mode }) => {
  if (!Object.hasOwn(profileDecisions, mode)) {
    throw new Error(`必须使用已登记的构建 Profile 启动 Vite：${mode}`);
  }
  const profile = mode as ReleaseProfile;
  const decision = profileDecisions[profile];
  const features = decision.include;
  const manifest = { schemaVersion: 1, profile, features };
  const define = Object.fromEntries(
    [
      "answer",
      "chat",
      "workspace",
      "interview",
      "settings",
      "account",
      "announcements",
      "updates",
      "stealth",
    ].map((feature) => [
      `__ANSWRA_FEATURE_${feature.toUpperCase()}__`,
      String(features.includes(feature as FeatureId)),
    ]),
  );
  define.__ANSWRA_RELEASE_MANIFEST__ = JSON.stringify(JSON.stringify(manifest));
  const rendererGraphAudit: Plugin = createRendererGraphAudit(profile);
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

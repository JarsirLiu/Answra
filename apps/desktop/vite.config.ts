import type { FeatureId, ReleaseProfile } from "@answra/shared";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { createRendererGraphAudit } from "./scripts/renderer-graph-audit.ts";
import { readViteReleaseConfig } from "./scripts/vite-release-config.ts";
import { createVscodeIconAssetPlugin } from "./scripts/vscode-icon-asset.ts";

const profileDecisions = await readViteReleaseConfig();

/** pnpm 把真实包放在 `node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/`，两种布局都要匹配。 */
const installedNodeModules = String.raw`node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?`;

/** 初始依赖按领域拆组：每组都低于 500 KB，避免单个入口 chunk 超过构建警告阈值。 */
const rendererChunkGroups = [
  {
    name: "vendor-react",
    test: new RegExp(`${installedNodeModules}(?:react|react-dom|scheduler)[\\/]`),
    priority: 40,
  },
  {
    name: "vendor-katex",
    test: new RegExp(`${installedNodeModules}katex[\\/]`),
    priority: 35,
  },
  {
    name: "vendor-editor",
    test: new RegExp(`${installedNodeModules}(?:@tiptap|prosemirror-)[^\\/]*[\\/]`),
    priority: 30,
  },
  {
    name: "vendor-ai",
    test: new RegExp(`${installedNodeModules}(?:ai|@ai-sdk|zod|eventsource-parser)[\\/]`),
    priority: 25,
  },
];

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
    plugins: [
      react(),
      rendererGraphAudit,
      ...(features.includes("workspace") ? [createVscodeIconAssetPlugin()] : []),
    ],
    define,
    build: {
      minify: "esbuild",
      sourcemap: false,
      manifest: true,
      rolldownOptions: {
        output: {
          codeSplitting: { groups: rendererChunkGroups },
        },
      },
    },
  };
});

import { defineConfig } from "vitest/config";
import { FEATURES, featureDefines } from "./release-features.mjs";

/** 主进程单测：node 环境跑纯逻辑；功能位按「全开」注入，不做 Electron 运行时。 */
export default defineConfig({
  define: featureDefines(Object.keys(FEATURES)),
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});

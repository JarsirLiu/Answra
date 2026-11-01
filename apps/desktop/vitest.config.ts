import { defineConfig } from "vitest/config";

/** 主进程单测：node 环境，纯逻辑测试，不加载 Electron 运行时。 */
export default defineConfig({
  define: Object.fromEntries(
    [
      "ANSWER",
      "CHAT",
      "WORKSPACE",
      "INTERVIEW",
      "SETTINGS",
      "ACCOUNT",
      "ANNOUNCEMENTS",
      "UPDATES",
      "STEALTH",
    ].map((feature) => [`__ANSWRA_FEATURE_${feature}__`, "true"]),
  ),
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});

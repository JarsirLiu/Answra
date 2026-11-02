import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  define: {
    __ANSWRA_FEATURE_CHAT__: "true",
    __ANSWRA_FEATURE_WORKSPACE__: "true",
    __ANSWRA_FEATURE_INTERVIEW__: "true",
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    // 懒加载运行时首次动态 import 会叠加到单测用时上，默认 5 秒在并行跑全量时不够。
    testTimeout: 15_000,
  },
});

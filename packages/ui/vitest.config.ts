import featureIds from "@answra/shared/release-features.json";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const UI_TEST_TIMEOUT_MS = 15_000;

// UI 测试按「功能全开」运行，功能裁剪只由构建期 Profile 决定。
const featureDefines = Object.fromEntries(
  featureIds.map((feature) => [
    `__ANSWRA_FEATURE_${feature.toUpperCase().replaceAll("-", "_")}__`,
    "true",
  ]),
);

export default defineConfig({
  plugins: [react()],
  define: featureDefines,
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    testTimeout: UI_TEST_TIMEOUT_MS,
  },
});

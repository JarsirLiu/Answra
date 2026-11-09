import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/core/tool/**/*.ts"],
      exclude: ["src/core/tool/index.ts", "src/core/tool/builtin/grepWorker.ts"],
      all: true,
      thresholds: {
        statements: 92,
        branches: 85,
        functions: 93,
        lines: 94,
      },
    },
  },
});

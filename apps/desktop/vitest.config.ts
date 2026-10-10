import { defineConfig } from "vitest/config";

/** 主进程单测：node 环境，纯逻辑测试，不加载 Electron 运行时。 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});

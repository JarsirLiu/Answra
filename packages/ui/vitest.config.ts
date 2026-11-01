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
  },
});

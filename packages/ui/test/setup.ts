import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// 并发 CI 下异步渲染会明显变慢；1s/5s 的轮询上限都会把「慢」误判成「失败」。
// 只放宽等待预算，断言本身不变；10s 仍小于 vitest.config.ts 的 15s 用例上限。
const ASYNC_UTIL_TIMEOUT_MS = 10_000;
configure({ asyncUtilTimeout: ASYNC_UTIL_TIMEOUT_MS });

afterEach(cleanup);

// jsdom has no layout engine; CodeMirror's scheduled measurement still expects Range geometry APIs.
if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
}

class TestResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: TestResizeObserver,
});

Object.defineProperty(URL, "createObjectURL", {
  configurable: true,
  value: vi.fn(() => "blob:exam-screenshot"),
});
Object.defineProperty(URL, "revokeObjectURL", {
  configurable: true,
  value: vi.fn(),
});

Object.defineProperty(window, "answra", {
  configurable: true,
  value: {
    fitContent: vi.fn(),
    close: vi.fn(),
    onAmbientColor: vi.fn(() => () => {}),
    setAmbientFollow: vi.fn(),
  },
});

if (
  typeof HTMLElement !== "undefined" &&
  !Object.getOwnPropertyDescriptor(HTMLElement.prototype, "isContentEditable")
) {
  Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get() {
      return this.getAttribute("contenteditable") === "true";
    },
  });
}

import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Markdown/编辑器运行时按需加载；测试环境首次解析动态 import 可能超过默认 1 秒。
configure({ asyncUtilTimeout: 5_000 });

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

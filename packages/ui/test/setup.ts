import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(cleanup);

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

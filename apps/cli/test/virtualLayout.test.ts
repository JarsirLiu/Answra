import { describe, expect, it } from "vitest";
import {
  buildOffsets,
  countTextLines,
  estimateMessageHeight,
  findVirtualWindow,
  maxScrollTop,
} from "../src/tui/components/virtualLayout";

describe("virtual transcript layout", () => {
  it("estimates wrapped lines using display width", () => {
    expect(countTextLines("中文中文", 4)).toBe(2);
    expect(countTextLines("🙂🙂", 4)).toBe(1);
    expect(countTextLines("a\nb", 80)).toBe(2);
  });

  it("only returns the visible window and offsets into the first item", () => {
    const offsets = buildOffsets(Array.from({ length: 40 }, () => 2));
    const top = findVirtualWindow(offsets, 0, 10, 0);
    expect(top.startIndex).toBe(0);
    expect(top.endIndex).toBeLessThan(40);

    const total = offsets[offsets.length - 1] ?? 0;
    const bottom = findVirtualWindow(offsets, maxScrollTop(total, 10), 10, 0);
    expect(bottom.startIndex).toBeGreaterThan(0);
    expect(bottom.endIndex).toBe(40);
    expect(bottom.offsetWithin).toBeLessThanOrEqual(2);
  });

  it("falls back to estimates until a row has been measured", () => {
    const message = {
      id: "assistant-1",
      role: "assistant" as const,
      text: "hello",
      status: "complete" as const,
      images: [],
      parts: [{ id: "text-1", kind: "text" as const, text: "hello", state: "completed" as const }],
    };
    expect(estimateMessageHeight(message, 80, false)).toBeGreaterThan(0);
  });
});

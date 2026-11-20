import { describe, expect, it } from "vitest";
import {
  buildOffsets,
  countTextLines,
  estimateCompactionBoundaryHeight,
  estimateMessageHeight,
  findVirtualWindow,
  maxScrollTop,
} from "../../../src/tui/transcript/virtualLayout";

describe("virtual transcript layout", () => {
  it("estimates wrapped lines using display width", () => {
    expect(countTextLines("中文中文", 4)).toBe(2);
    expect(countTextLines("????", 4)).toBe(1);
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

  it("counts a collapsed read/search group as one row", () => {
    const read = (id: string, path: string) => ({
      id,
      kind: "tool" as const,
      toolCallId: id,
      toolName: "Read",
      state: "completed" as const,
      input: { file_path: path },
      output: {
        type: "text",
        filePath: path,
        content: "x",
        numLines: 1,
        startLine: 1,
        totalLines: 1,
      },
    });
    const message = {
      id: "assistant-1",
      role: "assistant" as const,
      text: "",
      status: "complete" as const,
      images: [],
      parts: [read("tool-1", "src/a.ts"), read("tool-2", "src/b.ts")],
    };
    expect(estimateMessageHeight(message, 80, false)).toBe(2);
    expect(estimateMessageHeight(message, 80, true)).toBeGreaterThan(2);
  });

  it("reserves a margin for every assistant block", () => {
    const read = (id: string, path: string) => ({
      id,
      kind: "tool" as const,
      toolCallId: id,
      toolName: "Read",
      state: "completed" as const,
      input: { file_path: path },
      output: {
        type: "text",
        filePath: path,
        content: "x",
        numLines: 1,
        startLine: 1,
        totalLines: 1,
      },
    });
    const message = {
      id: "assistant-1",
      role: "assistant" as const,
      text: "",
      status: "complete" as const,
      images: [],
      parts: [
        read("tool-1", "src/a.ts"),
        read("tool-2", "src/b.ts"),
        { id: "text-1", kind: "text" as const, text: "收尾说明", state: "completed" as const },
      ],
    };
    expect(estimateMessageHeight(message, 80, false)).toBe(4);
  });

  it("reserves metadata lines only for the Compact summary metadata branch", () => {
    const boundary = {
      id: "compaction-1",
      summary: "## 当前目标\n继续实现压缩",
      summarizedMessages: 8,
    };
    const autoHeight = estimateCompactionBoundaryHeight(boundary, 80, false);
    const manualHeight = estimateCompactionBoundaryHeight(
      { ...boundary, instructions: "重点保留数据库迁移决定" },
      80,
      false,
    );
    expect(manualHeight).toBeGreaterThan(autoHeight);
    expect(
      estimateCompactionBoundaryHeight(
        { ...boundary, instructions: "重点保留数据库迁移决定" },
        80,
        true,
      ),
    ).toBe(estimateCompactionBoundaryHeight(boundary, 80, true));
  });

  it("does not reserve a separate row for user image attachments", () => {
    const image = { name: "capture.png", dataUrl: "data:image/png;base64,QUJD" };
    const imageOnly = {
      id: "user-1",
      role: "user" as const,
      text: "",
      status: "complete" as const,
      images: [image],
      parts: [],
    };
    const withText = { ...imageOnly, text: "look" };
    expect(estimateMessageHeight(imageOnly, 80, false)).toBe(1);
    expect(estimateMessageHeight(withText, 80, false)).toBe(2);
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

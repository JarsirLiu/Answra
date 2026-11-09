import { describe, expect, it } from "vitest";
import {
  createReadTextOutput,
  formatReadOutput,
  ReadOutputTooLargeError,
} from "../../../src/core/tool/builtin/readOutput";

const BASE = { bytesRead: 10, filePath: "/tmp/a.txt", sizeBytes: 10 };

describe("Read output projection", () => {
  it("selects a 1-based line range and numbers lines from the start line", () => {
    const output = createReadTextOutput({ ...BASE, text: "a\nb\nc", offset: 2, limit: 1 });

    expect(output).toMatchObject({
      type: "text",
      content: "b",
      numLines: 1,
      startLine: 2,
      totalLines: 3,
      truncated: false,
    });
    expect(formatReadOutput(output)).toBe("2\tb");
  });

  it("clamps offsets and limits to at least one", () => {
    const output = createReadTextOutput({ ...BASE, text: "a\nb\nc", offset: 0, limit: 0 });

    expect(output).toMatchObject({ content: "a", startLine: 1, numLines: 1, totalLines: 3 });
  });

  it("normalizes CRLF line endings", () => {
    const output = createReadTextOutput({ ...BASE, text: "a\r\nb" });

    expect(output).toMatchObject({ content: "a\nb", numLines: 2, totalLines: 2 });
    expect(formatReadOutput(output)).toBe("1\ta\n2\tb");
  });

  it("reports empty files with an explicit reminder", () => {
    const output = createReadTextOutput({ ...BASE, text: "" });

    expect(output).toMatchObject({ content: "", numLines: 0, totalLines: 0 });
    expect(formatReadOutput(output)).toContain("内容为空");
  });

  it("reports offsets past the end of the file", () => {
    const output = createReadTextOutput({ ...BASE, text: "a\nb", offset: 9 });

    expect(output).toMatchObject({ content: "", numLines: 0, totalLines: 2, startLine: 9 });
    expect(formatReadOutput(output)).toContain("文件只有 2 行");
  });

  it("falls back to a partial view with a continuation hint over the token cap", () => {
    const text = Array.from({ length: 5_000 }, () => "x".repeat(20)).join("\n");
    const output = createReadTextOutput({ ...BASE, text });

    expect(output).toMatchObject({ type: "text", truncated: true, truncatedByTokenCap: true });
    if (output.type !== "text") throw new Error("expected text output");
    expect(output.numLines).toBeLessThan(output.totalLines);
    expect(output.partialViewNotice).toContain("offset=");
    expect(formatReadOutput(output)).toContain("offset=");
  });

  it("truncates a single line that exceeds the token cap on its own", () => {
    const output = createReadTextOutput({ ...BASE, text: "x".repeat(100_000) });

    expect(output).toMatchObject({ type: "text", truncatedByTokenCap: true });
    expect(formatReadOutput(output)).toContain("第一行本身超过预算");
  });

  it("fails for an explicit range above the token cap instead of silently trimming", () => {
    expect(() =>
      createReadTextOutput({ ...BASE, text: "x".repeat(100_000), offset: 1, limit: 1 }),
    ).toThrow(ReadOutputTooLargeError);
  });

  it("formats file_unchanged as the wasted-call stub", () => {
    expect(formatReadOutput({ type: "file_unchanged", filePath: "/tmp/a.txt" })).toContain(
      "file unchanged",
    );
  });
});

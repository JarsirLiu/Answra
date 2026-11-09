import { describe, expect, it } from "vitest";
import { ToolExecutionError } from "../../../src/core/tool/executor/result";
import { applyResultBudget } from "../../../src/core/tool/executor/resultBudget";

describe("applyResultBudget", () => {
  it("passes inline content through even when it exceeds the character budget", () => {
    expect(applyResultBudget("abcdef", { strategy: "inline", maxModelChars: 3 })).toEqual({
      modelContent: "abcdef",
      truncated: false,
    });
  });

  it("truncates by character budget and appends the truncation marker", () => {
    expect(applyResultBudget("abcdef", { strategy: "truncate", maxModelChars: 3 })).toEqual({
      modelContent: "abc\n[输出已截断]",
      truncated: true,
    });
  });

  it("keeps content exactly at the character budget untouched", () => {
    expect(applyResultBudget("abcdef", { strategy: "truncate", maxModelChars: 6 })).toEqual({
      modelContent: "abcdef",
      truncated: false,
    });
  });

  it("truncates by UTF-8 bytes without splitting a multi-byte character", () => {
    expect(
      applyResultBudget("中文中文", {
        strategy: "truncate",
        maxModelChars: 100,
        maxModelBytes: 7,
      }),
    ).toEqual({ modelContent: "中文\n[输出已截断]", truncated: true });
  });

  it("keeps multi-byte content that exactly fills the byte budget", () => {
    expect(
      applyResultBudget("中", {
        strategy: "truncate",
        maxModelChars: 100,
        maxModelBytes: 3,
      }),
    ).toEqual({ modelContent: "中", truncated: false });
  });

  it("applies the byte budget before the character budget", () => {
    expect(
      applyResultBudget("中文中文", {
        strategy: "truncate",
        maxModelChars: 1,
        maxModelBytes: 7,
      }),
    ).toEqual({ modelContent: "中\n[输出已截断]", truncated: true });
  });

  it("reduces a zero character budget to the truncation marker only", () => {
    expect(applyResultBudget("abc", { strategy: "truncate", maxModelChars: 0 })).toEqual({
      modelContent: "\n[输出已截断]",
      truncated: true,
    });
  });

  it("fails explicitly for the unimplemented artifact budget", () => {
    expect(() => applyResultBudget("abc", { strategy: "artifact", maxModelChars: 10 })).toThrow(
      ToolExecutionError,
    );
    expect(() => applyResultBudget("abc", { strategy: "artifact", maxModelChars: 10 })).toThrow(
      "artifact 结果预算尚未实现",
    );
  });
});

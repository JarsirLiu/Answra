import { describe, expect, it } from "vitest";
import {
  formatHiddenLines,
  headPreview,
  tailPreview,
} from "../../../../../src/tui/transcript/tool/details/previewText";

describe("tool preview text", () => {
  it("keeps the head and reports hidden lines", () => {
    expect(headPreview("a\nb\nc\nd\ne", 3)).toEqual({
      text: "a\nb\nc",
      hidden: 2,
      truncated: true,
    });
    expect(formatHiddenLines(2)).toBe("… +2 lines");
  });

  it("keeps the tail for running commands", () => {
    expect(tailPreview("a\nb\nc\nd\ne", 3)).toEqual({
      text: "c\nd\ne",
      hidden: 2,
      truncated: true,
    });
  });

  it("does not add a hidden notice when the text fits", () => {
    expect(headPreview("a\nb", 3)).toEqual({ text: "a\nb", hidden: 0, truncated: false });
    expect(formatHiddenLines(0)).toBeUndefined();
  });
});

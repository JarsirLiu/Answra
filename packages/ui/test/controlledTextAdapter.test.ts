import { describe, expect, it } from "vitest";
import { backwardDeletionRange, replaceTextRange } from "../src/ime/adapters/controlledTextAdapter";

describe("controlled text adapter", () => {
  it("replaces a selection and returns the resulting caret", () => {
    expect(replaceTextRange("hello world", { start: 6, end: 11 }, "Answra")).toEqual({
      value: "hello Answra",
      caret: 12,
    });
  });

  it("clamps stale offsets and normalizes reversed ranges", () => {
    expect(replaceTextRange("abc", { start: 20, end: 1 }, "x")).toEqual({
      value: "ax",
      caret: 2,
    });
  });

  it("deletes the selection or the preceding character", () => {
    expect(backwardDeletionRange("abcd", { start: 1, end: 3 })).toEqual({ start: 1, end: 3 });
    expect(backwardDeletionRange("abcd", { start: 3, end: 3 })).toEqual({ start: 2, end: 3 });
    expect(backwardDeletionRange("abcd", { start: 0, end: 0 })).toEqual({ start: 0, end: 0 });
  });
});

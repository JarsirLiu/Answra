import { describe, expect, it } from "vitest";
import { splitSpeechText } from "../../src/chunk/split";

describe("splitSpeechText", () => {
  it("returns nothing for blank text", () => {
    expect(splitSpeechText("", 10)).toEqual([]);
    expect(splitSpeechText("   \n ", 10)).toEqual([]);
  });

  it("keeps text within the limit as one segment", () => {
    expect(splitSpeechText("你好。", 10)).toEqual(["你好。"]);
  });

  it("splits on sentence boundaries without losing characters", () => {
    const text = "第一句。第二句！第三句？";
    const chunks = splitSpeechText(text, 5);

    expect(chunks).toEqual(["第一句。", "第二句！", "第三句？"]);
    expect(chunks.join("")).toBe(text);
  });

  it("hard-splits an over-long sentence", () => {
    expect(splitSpeechText("abcdefghij", 3)).toEqual(["abc", "def", "ghi", "j"]);
  });

  it("never splits a surrogate pair", () => {
    const chunks = splitSpeechText("😀😀😀", 3);

    expect(chunks).toEqual(["😀", "😀", "😀"]);
    expect(chunks.join("")).toBe("😀😀😀");
  });

  it("rejects a non-positive limit", () => {
    expect(() => splitSpeechText("你好。", 0)).toThrowError(RangeError);
    expect(() => splitSpeechText("你好。", 1.5)).toThrowError(RangeError);
  });
});

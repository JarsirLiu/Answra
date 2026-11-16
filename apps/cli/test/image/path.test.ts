import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { imagePathsFromText } from "../../src/image/path";

describe("image path detection", () => {
  it("extracts a quoted absolute Windows path", () => {
    expect(imagePathsFromText('"C:\\shots\\capture.png"')).toEqual(["C:\\shots\\capture.png"]);
  });

  it("extracts multiple image paths separated by newlines", () => {
    expect(imagePathsFromText("C:\\shots\\one.png\r\nC:\\shots\\two.jpg\n")).toEqual([
      "C:\\shots\\one.png",
      "C:\\shots\\two.jpg",
    ]);
  });

  it("keeps spaces inside an absolute path", () => {
    expect(imagePathsFromText("C:\\shots\\screen shot.webp")).toEqual([
      "C:\\shots\\screen shot.webp",
    ]);
  });

  it("accepts file URLs", () => {
    const path = process.platform === "win32" ? "C:\\shots\\capture.png" : "/tmp/capture.png";
    expect(imagePathsFromText(pathToFileURL(path).href)).toEqual([path]);
  });

  it("does not treat relative paths or mixed text as image paste", () => {
    expect(imagePathsFromText("shots/capture.png")).toEqual([]);
    expect(imagePathsFromText("look at C:\\shots\\capture.png")).toEqual([]);
  });

  it("does not treat unsupported extensions as images", () => {
    expect(imagePathsFromText("C:\\shots\\capture.bmp")).toEqual([]);
  });
});

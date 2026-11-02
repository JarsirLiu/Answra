import { describe, expect, it } from "vitest";
import { isMarkdownPath, resolveMarkdownImagePath } from "../src/main/markdown";

describe("Markdown file association", () => {
  it("accepts .md files with case-insensitive extensions and spaced paths", () => {
    expect(isMarkdownPath("C:/Users/Ada Notes/meeting.MD")).toBe(true);
  });

  it("rejects other extensions and extensionless paths", () => {
    expect(isMarkdownPath("notes.txt")).toBe(false);
    expect(isMarkdownPath("notes")).toBe(false);
  });

  it("resolves relative image references beside the Markdown document", () => {
    expect(resolveMarkdownImagePath("C:/Notes/guides/start.md", "images/cover%20photo.png")).toBe(
      "C:\\Notes\\guides\\images\\cover photo.png",
    );
  });

  it("rejects absolute and escaping image references", () => {
    expect(() => resolveMarkdownImagePath("C:/Notes/start.md", "../../secrets.png")).toThrow();
    expect(() => resolveMarkdownImagePath("C:/Notes/start.md", "C:/secrets.png")).toThrow();
    expect(() => resolveMarkdownImagePath("C:/Notes/start.md", "..\\..\\secrets.png")).toThrow();
  });
});

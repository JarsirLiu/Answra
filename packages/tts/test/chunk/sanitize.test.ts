import { describe, expect, it } from "vitest";
import { createSpeechSanitizer, sanitizeSpeechText } from "../../src/chunk/sanitize";

describe("sanitizeSpeechText", () => {
  it("strips emphasis markers but keeps the words", () => {
    expect(sanitizeSpeechText("这是**重点**，还有 _斜体_。")).toBe("这是重点，还有 斜体。");
  });

  it("keeps link text and drops the destination", () => {
    expect(sanitizeSpeechText("请看[这里](https://example.com)。")).toBe("请看这里。");
  });

  it("drops images entirely", () => {
    expect(sanitizeSpeechText("前![图](https://example.com/a.png)后")).toBe("前后");
  });

  it("strips headings, list markers and quotes", () => {
    const text = "## 标题\n- 第一项\n> 引用";
    expect(sanitizeSpeechText(text)).toBe("标题\n第一项\n引用");
  });

  it("drops fenced code blocks", () => {
    expect(sanitizeSpeechText("前文\n```ts\nconst x = 1\n```\n后文")).toBe("前文\n后文");
  });

  it("keeps inline code content without backticks", () => {
    expect(sanitizeSpeechText("运行 `pnpm test` 即可")).toBe("运行 pnpm test 即可");
  });

  it("keeps bracketed text without a destination and drops the brackets", () => {
    expect(sanitizeSpeechText("看[这里]")).toBe("看这里");
  });
});

describe("createSpeechSanitizer", () => {
  it("handles emphasis markers split across deltas", () => {
    const sanitizer = createSpeechSanitizer();
    const output = sanitizer.push("这是**重") + sanitizer.push("点**") + sanitizer.flush();

    expect(output).toBe("这是重点");
  });

  it("waits for a link destination split across deltas", () => {
    const sanitizer = createSpeechSanitizer();
    const output =
      sanitizer.push("请看[这里") +
      sanitizer.push("](https://example") +
      sanitizer.push(".com)。") +
      sanitizer.flush();

    expect(output).toBe("请看这里。");
  });

  it("drops a fenced block whose fence spans deltas", () => {
    const sanitizer = createSpeechSanitizer();
    const output =
      sanitizer.push("前文\n```ts\nconst x = 1\n") +
      sanitizer.push("```\n") +
      sanitizer.push("后文") +
      sanitizer.flush();

    expect(output).toBe("前文\n后文");
  });

  it("emits the tail on flush even when a marker is unclosed", () => {
    const sanitizer = createSpeechSanitizer();

    expect(sanitizer.push("未闭合的**重点")).toBe("未闭合的重点");
    expect(sanitizer.flush()).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { createStreamingChunker } from "../../src/chunk/stream";

function chunkAll(deltas: readonly string[], options: { maxChars: number } = { maxChars: 100 }) {
  const chunker = createStreamingChunker(options);
  const chunks = deltas.flatMap((delta) => chunker.push(delta));
  chunks.push(...chunker.flush());
  return chunks;
}

describe("createStreamingChunker", () => {
  it("emits each sentence as its own chunk", () => {
    expect(chunkAll(["第一句。第二句！"])).toEqual(["第一句。", "第二句！"]);
  });

  it("keeps characters when a sentence boundary spans deltas", () => {
    const chunks = chunkAll(["第一句", "。第二", "句。"]);

    expect(chunks).toEqual(["第一句。", "第二句。"]);
    expect(chunks.join("")).toBe("第一句。第二句。");
  });

  it("emits an opening clause early at a comma once it has enough words", () => {
    const text = "one two three four five, six seven eight nine ten.";
    const chunks = chunkAll([text]);

    expect(chunks[0]).toBe("one two three four five,");
    expect(chunks.join(" ")).toBe(text);
  });

  it("does not split a short clause at a comma", () => {
    const chunks = chunkAll(["one two, three four five six seven eight nine ten."]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("one two, three four five six seven eight nine ten.");
  });

  it("does not treat a decimal point as a sentence end", () => {
    expect(chunkAll(["圆周率是3.14。"])).toEqual(["圆周率是3.14。"]);
  });

  it("flushes trailing text without punctuation", () => {
    const chunker = createStreamingChunker({ maxChars: 100 });

    expect(chunker.push("没有句号的一段")).toEqual([]);
    expect(chunker.flush()).toEqual(["没有句号的一段"]);
  });

  it("hard-splits text longer than the provider limit", () => {
    expect(chunkAll(["abcdefghij"], { maxChars: 5 })).toEqual(["abcde", "fghij"]);
  });

  it("drops chunks without readable sound", () => {
    expect(chunkAll(["。。。"])).toEqual([]);
  });
});

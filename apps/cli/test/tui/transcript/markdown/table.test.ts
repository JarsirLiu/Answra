import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { layoutMarkdownTable, parseTableAt } from "../../../../src/tui/transcript/markdown/table";

const SOURCE = ["| Name | Score |", "| :--- | ---: |", "| Alice | 10 |", "| 张三 | 9 |"];

describe("markdown table parsing", () => {
  it("reads the header, alignment, rows and stops before ordinary text", () => {
    const parsed = parseTableAt([...SOURCE, "", "after"], 0);
    expect(parsed?.table.header).toEqual(["Name", "Score"]);
    expect(parsed?.table.align).toEqual(["left", "right"]);
    expect(parsed?.table.rows).toEqual([
      ["Alice", "10"],
      ["张三", "9"],
    ]);
    expect(parsed?.nextIndex).toBe(4);
  });

  it("keeps escaped pipes inside a cell and strips inline markers", () => {
    const parsed = parseTableAt(["| **A** | `b` \\| c |", "| --- | --- |"], 0);
    expect(parsed?.table.header).toEqual(["A", "b | c"]);
    expect(parsed?.table.rows).toEqual([]);
  });

  it("does not treat a paragraph containing a pipe as a table", () => {
    expect(parseTableAt(["a | b", "plain text"], 0)).toBeUndefined();
  });
});

describe("markdown table layout", () => {
  it("renders a bordered table with a header separator and aligned cells", () => {
    const table = parseTableAt(SOURCE, 0)?.table;
    if (table === undefined) throw new Error("table not parsed");

    const lines = layoutMarkdownTable(table, 80);
    expect(lines[0]).toContain("┌");
    expect(lines[0]).toContain("┬");
    expect(lines[1]).toContain("Name");
    expect(lines[2]).toContain("├");
    expect(lines[3]).toContain("Alice");
    expect(lines[3]).toContain("   10");
    expect(lines[lines.length - 1]).toContain("└");
    expect(new Set(lines.map((line) => stringWidth(line))).size).toBe(1);
  });

  it("degrades to key-value rows when the terminal cannot fit the columns", () => {
    const table = parseTableAt(SOURCE, 0)?.table;
    if (table === undefined) throw new Error("table not parsed");

    const lines = layoutMarkdownTable(table, 10);
    expect(lines.join("\n")).toContain("Name: Alic");
    expect(lines.join("\n")).toContain("张三");
    expect(lines[0]).not.toContain("┌");
  });
});

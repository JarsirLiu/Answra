import { describe, expect, it } from "vitest";
import { buildEditDiff } from "../src/components/tool-call/renderers/editDiff";

describe("buildEditDiff", () => {
  it("keeps shared context and marks removed and added lines", () => {
    const diff = buildEditDiff("a\nb\nc", "a\nB\nc");

    expect(diff.lines).toEqual([
      { kind: "context", oldLine: 1, newLine: 1, text: "a" },
      { kind: "removed", oldLine: 2, text: "b" },
      { kind: "added", newLine: 2, text: "B" },
      { kind: "context", oldLine: 3, newLine: 3, text: "c" },
    ]);
    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(1);
    expect(diff.truncated).toBe(false);
  });

  it("derives line numbers from Read prefixes", () => {
    const diff = buildEditDiff("292\tone\n293\ttwo\n294\tthree", "one\nTWO\nthree");

    expect(diff.lines).toEqual([
      { kind: "context", oldLine: 292, newLine: 292, text: "one" },
      { kind: "removed", oldLine: 293, text: "two" },
      { kind: "added", newLine: 293, text: "TWO" },
      { kind: "context", oldLine: 294, newLine: 294, text: "three" },
    ]);
  });

  it("normalizes CRLF and handles a deletion", () => {
    const diff = buildEditDiff("a\r\nb\r\n", "");

    expect(diff.lines).toEqual([
      { kind: "removed", oldLine: 1, text: "a" },
      { kind: "removed", oldLine: 2, text: "b" },
      { kind: "removed", oldLine: 3, text: "" },
    ]);
    expect(diff.additions).toBe(0);
    expect(diff.deletions).toBe(3);
  });

  it("caps very large snippets", () => {
    const oldLines = Array.from({ length: 601 }, (_, index) => `line ${index + 1}`);
    const newLines = [...oldLines];
    newLines[599] = "changed";

    const diff = buildEditDiff(oldLines.join("\n"), newLines.join("\n"));

    expect(diff.truncated).toBe(true);
    expect(diff.lines).toHaveLength(600);
    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(1);
  });
});

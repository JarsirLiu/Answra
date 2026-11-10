import { describe, expect, it } from "vitest";
import { buildEditDisplayDiff } from "../../../src/core/tool/builtin/editDisplayDiff";

describe("buildEditDisplayDiff", () => {
  it("shows context around a single replacement with real line numbers", () => {
    const before = lines(12, { 5: "old" });
    const after = lines(12, { 5: "new" });

    const diff = buildEditDisplayDiff(before, after);

    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(1);
    expect(diff.truncated).toBe(false);
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]).toMatchObject({ oldStart: 2, oldLines: 7, newStart: 2, newLines: 7 });
    expect(diff.hunks[0]?.lines).toEqual([
      { kind: "context", text: "line 2" },
      { kind: "context", text: "line 3" },
      { kind: "context", text: "line 4" },
      { kind: "removed", text: "old" },
      { kind: "added", text: "new" },
      { kind: "context", text: "line 6" },
      { kind: "context", text: "line 7" },
      { kind: "context", text: "line 8" },
    ]);
  });

  it("keeps far-apart changes as separate hunks", () => {
    const before = lines(24, { 5: "old-a", 19: "old-b" });
    const after = lines(24, { 5: "new-a", 19: "new-b" });

    const diff = buildEditDisplayDiff(before, after);

    expect(diff.hunks).toHaveLength(2);
    expect(diff.hunks[0]).toMatchObject({ oldStart: 2, oldLines: 7, newStart: 2, newLines: 7 });
    expect(diff.hunks[1]).toMatchObject({ oldStart: 16, oldLines: 7, newStart: 16, newLines: 7 });
    expect(diff.hunks[0]?.lines.map((line) => line.text)).toContain("old-a");
    expect(diff.hunks[1]?.lines.map((line) => line.text)).toContain("new-b");
  });

  it("merges changes whose unmodified gap is at most six lines", () => {
    const before = lines(24, { 5: "old-a", 12: "old-b" });
    const after = lines(24, { 5: "new-a", 12: "new-b" });

    const diff = buildEditDisplayDiff(before, after);

    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]).toMatchObject({ oldStart: 2, oldLines: 14, newStart: 2, newLines: 14 });
    const kinds = diff.hunks[0]?.lines.map((line) => line.kind);
    expect(kinds?.filter((kind) => kind === "removed")).toHaveLength(2);
    expect(kinds?.filter((kind) => kind === "added")).toHaveLength(2);
  });

  it("normalizes CRLF and handles an insertion at the start", () => {
    const diff = buildEditDisplayDiff("a\r\nb", "new\na\r\nb");

    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3 });
    expect(diff.hunks[0]?.lines).toEqual([
      { kind: "added", text: "new" },
      { kind: "context", text: "a" },
      { kind: "context", text: "b" },
    ]);
  });

  it("handles a replacement that ends the file", () => {
    const diff = buildEditDisplayDiff("a\nb\nlast", "a\nb\nLAST");

    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 });
    expect(diff.hunks[0]?.lines.at(-1)).toEqual({ kind: "added", text: "LAST" });
  });

  it("returns no hunks when the text did not change", () => {
    expect(buildEditDisplayDiff("same", "same")).toEqual({
      hunks: [],
      additions: 0,
      deletions: 0,
      truncated: false,
    });
  });

  it("caps the number of visible hunks", () => {
    const changes = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [5 + index * 10, `old-${index}`]),
    );
    const next = Object.fromEntries(Object.keys(changes).map((line) => [line, `new-${line}`]));

    const diff = buildEditDisplayDiff(lines(220, changes), lines(220, next));

    expect(diff.hunks).toHaveLength(20);
    expect(diff.truncated).toBe(true);
  });

  it("caps a single oversized hunk and reports truncation", () => {
    const before = lines(700);
    const after = lines(
      700,
      Object.fromEntries(Array.from({ length: 700 }, (_, index) => [index + 1, "changed"])),
    );

    const diff = buildEditDisplayDiff(before, after);

    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]?.lines).toHaveLength(600);
    expect(diff.additions).toBe(700);
    expect(diff.deletions).toBe(700);
    expect(diff.truncated).toBe(true);
  });
});

function lines(count: number, replacements: Record<number, string> = {}): string {
  return Array.from({ length: count }, (_, index) => {
    const line = index + 1;
    return replacements[line] ?? `line ${line}`;
  }).join("\n");
}

import { describe, expect, it } from "vitest";
import {
  formatGrepOutput,
  type ParseGrepOutputOptions,
  parseGrepOutput,
} from "../../../src/core/tool/builtin/grepOutput";

interface MatchEventInput {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly submatches?: readonly string[];
}

const BASE_OPTIONS: ParseGrepOutputOptions = {
  afterContext: 0,
  beforeContext: 0,
  headLimit: 250,
  lineNumbers: true,
  offset: 0,
  onlyMatching: false,
  outputMode: "content",
};

function matchEvent(input: MatchEventInput): string {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: input.path },
      lines: { text: `${input.text}\n` },
      line_number: input.line,
      ...(input.submatches
        ? { submatches: input.submatches.map((text) => ({ match: { text } })) }
        : {}),
    },
  });
}

function contextEvent(path: string, line: number, text: string): string {
  return JSON.stringify({
    type: "context",
    data: { path: { text: path }, lines: { text: `${text}\n` }, line_number: line },
  });
}

function parse(events: readonly string[], overrides: Partial<ParseGrepOutputOptions> = {}) {
  return parseGrepOutput(events.join("\n"), { ...BASE_OPTIONS, ...overrides });
}

describe("Grep output parsing", () => {
  it("lists each matching file once in files_with_matches mode", () => {
    const output = parse(
      [
        matchEvent({ path: "a.txt", line: 1, text: "needle" }),
        matchEvent({ path: "a.txt", line: 2, text: "needle" }),
        matchEvent({ path: "b.txt", line: 1, text: "needle" }),
      ],
      { outputMode: "files_with_matches" },
    );

    expect(output).toEqual({
      type: "files_with_matches",
      files: ["a.txt", "b.txt"],
      truncated: false,
    });
    expect(formatGrepOutput(output)).toBe("a.txt\nb.txt");
  });

  it("counts matches per file", () => {
    const output = parse(
      [
        matchEvent({ path: "a.txt", line: 1, text: "needle" }),
        matchEvent({ path: "a.txt", line: 2, text: "needle" }),
        matchEvent({ path: "b.txt", line: 1, text: "needle" }),
      ],
      { outputMode: "count" },
    );

    expect(output).toEqual({
      type: "count",
      counts: [
        { path: "a.txt", count: 2 },
        { path: "b.txt", count: 1 },
      ],
      truncated: false,
    });
    expect(formatGrepOutput(output)).toBe("a.txt:2\nb.txt:1");
  });

  it("skips malformed JSON, non-match events, and incomplete records", () => {
    const output = parse([
      "not json",
      JSON.stringify({ type: "begin", data: {} }),
      JSON.stringify({ type: "match", data: { lines: { text: "x\n" }, line_number: 1 } }),
      JSON.stringify({ type: "match", data: { path: { text: "a.txt" }, line_number: 1 } }),
      matchEvent({ path: "a.txt", line: 1, text: "needle" }),
    ]);

    expect(output).toMatchObject({ type: "content", totalMatches: 1 });
  });

  it("renders context lines with gaps and match line numbers", () => {
    const output = parse(
      [
        matchEvent({ path: "a.txt", line: 1, text: "first" }),
        contextEvent("a.txt", 4, "before"),
        matchEvent({ path: "a.txt", line: 5, text: "fifth" }),
      ],
      { beforeContext: 1 },
    );

    expect(formatGrepOutput(output)).toBe(
      ["a.txt:1:first", "--", "a.txt-4-before", "a.txt:5:fifth"].join("\n"),
    );
  });

  it("keeps match text when a context event targets the same line", () => {
    const fromContextFirst = parse([
      contextEvent("a.txt", 2, "context"),
      matchEvent({ path: "a.txt", line: 2, text: "match" }),
    ]);
    const fromMatchFirst = parse([
      matchEvent({ path: "a.txt", line: 2, text: "match" }),
      contextEvent("a.txt", 2, "context"),
    ]);

    expect(formatGrepOutput(fromContextFirst)).toBe("a.txt:2:match");
    expect(formatGrepOutput(fromMatchFirst)).toBe("a.txt:2:match");
  });

  it("uses submatches for only-matching output and falls back to the full line", () => {
    const matched = parse(
      [
        matchEvent({
          path: "a.txt",
          line: 2,
          text: "prefix needle suffix",
          submatches: ["needle"],
        }),
      ],
      { onlyMatching: true },
    );
    const fallback = parse([matchEvent({ path: "a.txt", line: 2, text: "needle" })], {
      onlyMatching: true,
    });

    expect(formatGrepOutput(matched)).toBe("a.txt:2:needle");
    expect(formatGrepOutput(fallback)).toBe("a.txt:2:needle");
  });

  it("splits multiline matches into consecutive numbered lines", () => {
    const output = parse([matchEvent({ path: "a.txt", line: 1, text: "alpha\nbeta" })]);

    expect(formatGrepOutput(output)).toBe("a.txt:1:alpha\na.txt:2:beta");
  });

  it("normalizes Windows separators, dot-prefixes, and CRLF text", () => {
    const output = parse(
      [
        matchEvent({ path: "src\\nested\\a.ts", line: 1, text: "alpha\r\nbeta" }),
        matchEvent({ path: "./b.txt", line: 1, text: "needle" }),
      ],
      { outputMode: "files_with_matches" },
    );

    expect(output).toMatchObject({ files: ["src/nested/a.ts", "b.txt"] });
  });

  it("normalizes missing and zero line numbers to one", () => {
    const output = parse([
      JSON.stringify({
        type: "match",
        data: { path: { text: "missing.txt" }, lines: { text: "x\n" } },
      }),
      matchEvent({ path: "zero.txt", line: 0, text: "y" }),
    ]);

    expect(formatGrepOutput(output)).toContain("missing.txt:1:x");
    expect(formatGrepOutput(output)).toContain("zero.txt:1:y");
  });

  it("truncates long lines in the model projection", () => {
    const output = parse([matchEvent({ path: "a.txt", line: 1, text: "x".repeat(600) })], {
      outputMode: "content",
    });
    const text = formatGrepOutput(output);

    expect(text).toContain("…");
    expect(text).not.toContain("x".repeat(501));
  });

  it("pages content matches with offset and head_limit", () => {
    const events = [
      matchEvent({ path: "a.txt", line: 1, text: "one" }),
      matchEvent({ path: "a.txt", line: 2, text: "two" }),
      matchEvent({ path: "a.txt", line: 3, text: "three" }),
    ];
    const paged = parse(events, { offset: 1, headLimit: 1 });
    const unlimited = parse(events, { headLimit: 0 });

    expect(paged).toMatchObject({ totalMatches: 3, shownMatches: 1, truncated: true });
    expect(formatGrepOutput(paged)).toBe("a.txt:2:two\n[结果达到上限]");
    expect(unlimited).toMatchObject({ totalMatches: 3, shownMatches: 3, truncated: false });
    expect(formatGrepOutput(unlimited)).not.toContain("[结果达到上限]");
  });

  it("pages files and counts with offset and head_limit", () => {
    const events = [
      matchEvent({ path: "a.txt", line: 1, text: "needle" }),
      matchEvent({ path: "b.txt", line: 1, text: "needle" }),
      matchEvent({ path: "c.txt", line: 1, text: "needle" }),
    ];
    const files = parse(events, { outputMode: "files_with_matches", offset: 1, headLimit: 1 });
    const counts = parse(events, { outputMode: "count", offset: 0, headLimit: 2 });

    expect(files).toMatchObject({ files: ["b.txt"], truncated: true });
    expect(counts).toMatchObject({
      counts: [
        { path: "a.txt", count: 1 },
        { path: "b.txt", count: 1 },
      ],
      truncated: true,
    });
  });

  it("omits line numbers when requested", () => {
    const output = parse([matchEvent({ path: "a.txt", line: 7, text: "needle" })], {
      lineNumbers: false,
    });

    expect(formatGrepOutput(output)).toBe("a.txt:needle");
  });

  it("reports no matches for every output mode", () => {
    for (const outputMode of ["content", "files_with_matches", "count"] as const) {
      expect(formatGrepOutput(parse([], { outputMode }))).toBe("未找到匹配内容");
    }
  });
});

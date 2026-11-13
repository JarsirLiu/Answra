/** Grep presenter: search summary plus bounded match/file/count details. */
import { clipDetailText, oneLine, TOOL_LIST_MAX_ITEMS } from "../limits";
import type { ToolDetail, ToolPresentation, ToolPresenterContext } from "../types";
import { asRecord, numberField, stringArray, stringField } from "../value";

const TRUNCATED_SUFFIX = "\n[结果达到上限]";

interface GrepLine {
  readonly lineNumber: number;
  readonly text: string;
  readonly kind: "match" | "context";
}

interface GrepFileContent {
  readonly path: string;
  readonly lines: readonly GrepLine[];
}

interface GrepContentOutput {
  readonly type: "content";
  readonly files: readonly GrepFileContent[];
  readonly totalMatches: number;
  readonly shownMatches: number;
  readonly truncated: boolean;
  readonly lineNumbers: boolean;
}

interface GrepFilesOutput {
  readonly type: "files_with_matches";
  readonly files: readonly string[];
  readonly truncated: boolean;
}

interface GrepCountOutput {
  readonly type: "count";
  readonly counts: readonly { readonly path: string; readonly count: number }[];
  readonly truncated: boolean;
}

type GrepOutput = GrepContentOutput | GrepFilesOutput | GrepCountOutput;

export function presentGrep(context: ToolPresenterContext): ToolPresentation {
  const input = asRecord(context.input);
  const pattern = input ? stringField(input, "pattern") : undefined;
  const path = input ? stringField(input, "path") : undefined;
  const glob = input ? stringField(input, "glob") : undefined;
  const type = input ? stringField(input, "type") : undefined;
  const output = parseGrepOutput(context.output);
  const legacy = output === undefined ? parseLegacyOutput(context.output, input) : undefined;
  const details = output ? detailsFor(output) : legacy ? detailsForLegacy(legacy) : [];
  const resultLine = output
    ? resultLineFor(output)
    : legacy
      ? legacyResultLine(legacy)
      : context.state === "completed"
        ? "Found 0 files"
        : undefined;

  return {
    toolName: context.toolName,
    action: "search",
    category: "search",
    state: context.state,
    primary: pattern ? oneLine(pattern) : (context.title ?? "search"),
    ...(path ? { secondary: oneLine(path) } : glob ? { secondary: `glob:${glob}` } : {}),
    ...(type ? { meta: `type:${type}` } : {}),
    ...(resultLine ? { resultLine } : {}),
    ...(context.errorText ? { errorText: context.errorText } : {}),
    details,
    expandable: details.length > 0,
  };
}

function detailsFor(output: GrepOutput): ToolDetail[] {
  switch (output.type) {
    case "content": {
      const lines = formatContentLines(output);
      const clipped = clipDetailText(lines);
      return clipped.text.length === 0
        ? []
        : [
            {
              kind: "text",
              text: clipped.text,
              wrap: false,
              truncated: clipped.truncated || output.truncated,
              totalLines: clipped.totalLines,
            },
          ];
    }
    case "files_with_matches": {
      const files = output.files.slice(0, TOOL_LIST_MAX_ITEMS);
      return files.length === 0
        ? []
        : [
            {
              kind: "text",
              text: files.join("\n"),
              wrap: false,
              truncated: output.truncated || output.files.length > files.length,
              totalLines: output.files.length,
            },
          ];
    }
    case "count": {
      const counts = output.counts.slice(0, TOOL_LIST_MAX_ITEMS);
      return counts.length === 0
        ? []
        : [
            {
              kind: "text",
              text: counts.map((entry) => `${entry.path}:${entry.count}`).join("\n"),
              wrap: false,
              truncated: output.truncated || output.counts.length > counts.length,
              totalLines: output.counts.length,
            },
          ];
    }
  }
}

function detailsForLegacy(output: LegacyOutput): ToolDetail[] {
  const clipped = clipDetailText(output.text);
  if (clipped.text.length === 0) return [];
  return [
    {
      kind: "text",
      text: clipped.text,
      wrap: false,
      truncated: clipped.truncated || output.truncated,
      totalLines: clipped.totalLines,
    },
  ];
}

function resultLineFor(output: GrepOutput): string {
  switch (output.type) {
    case "content": {
      const lines = output.files.reduce(
        (total, file) => total + file.lines.filter((line) => line.kind === "match").length,
        0,
      );
      return `Found ${lines} ${lines === 1 ? "line" : "lines"}`;
    }
    case "files_with_matches":
      return `Found ${output.files.length} ${output.files.length === 1 ? "file" : "files"}`;
    case "count": {
      const matches = output.counts.reduce((total, entry) => total + entry.count, 0);
      return `Found ${matches} ${matches === 1 ? "match" : "matches"} across ${output.counts.length} ${output.counts.length === 1 ? "file" : "files"}`;
    }
  }
}

function formatContentLines(output: GrepContentOutput): string {
  const groups: string[] = [];
  for (const file of output.files) {
    for (const line of file.lines) {
      const separator = line.kind === "match" ? ":" : "-";
      const number = output.lineNumbers ? `${line.lineNumber}` : "";
      groups.push(
        number.length === 0
          ? `${file.path}${separator}${line.text}`
          : `${file.path}${separator}${number}${separator}${line.text}`,
      );
    }
  }
  return groups.join("\n");
}

interface LegacyOutput {
  readonly text: string;
  readonly truncated: boolean;
  readonly mode: "content" | "files_with_matches" | "count";
}

function parseLegacyOutput(
  value: unknown,
  input: Record<string, unknown> | undefined,
): LegacyOutput | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replaceAll("\r\n", "\n").trimEnd();
  if (normalized.length === 0) return undefined;
  const truncated = normalized.endsWith(TRUNCATED_SUFFIX);
  const text = truncated ? normalized.slice(0, -TRUNCATED_SUFFIX.length).trimEnd() : normalized;
  const mode = input ? stringField(input, "output_mode") : undefined;
  return {
    text,
    truncated,
    mode: mode === "content" || mode === "count" ? mode : "files_with_matches",
  };
}

function legacyResultLine(output: LegacyOutput): string {
  const lines = output.text.split("\n").filter((line) => line.trim().length > 0);
  if (output.mode === "files_with_matches") {
    return `Found ${lines.length} ${lines.length === 1 ? "file" : "files"}`;
  }
  return `Found ${lines.length} ${lines.length === 1 ? "line" : "lines"}`;
}

export function parseGrepOutput(value: unknown): GrepOutput | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const type = stringField(record, "type");
  if (type === "content") return parseContent(record);
  if (type === "files_with_matches") return parseFiles(record);
  if (type === "count") return parseCount(record);
  return undefined;
}

function parseContent(record: Record<string, unknown>): GrepContentOutput | undefined {
  if (!Array.isArray(record.files)) return undefined;
  const files: GrepFileContent[] = [];
  for (const rawFile of record.files) {
    const file = asRecord(rawFile);
    const path = file ? stringField(file, "path") : undefined;
    if (!file || !path || !Array.isArray(file.lines)) return undefined;
    const lines: GrepLine[] = [];
    for (const rawLine of file.lines) {
      const line = asRecord(rawLine);
      const lineNumber = line ? numberField(line, "lineNumber") : undefined;
      const text = line ? stringField(line, "text") : undefined;
      const kind = line ? stringField(line, "kind") : undefined;
      if (lineNumber === undefined || text === undefined) return undefined;
      if (kind !== "match" && kind !== "context") return undefined;
      lines.push({ lineNumber, text, kind });
    }
    files.push({ path, lines });
  }
  return {
    type: "content",
    files,
    totalMatches: numberField(record, "totalMatches") ?? 0,
    shownMatches: numberField(record, "shownMatches") ?? 0,
    truncated: record.truncated === true,
    lineNumbers: record.lineNumbers === true,
  };
}

function parseFiles(record: Record<string, unknown>): GrepFilesOutput | undefined {
  const files = stringArray(record.files);
  if (!files) return undefined;
  return { type: "files_with_matches", files, truncated: record.truncated === true };
}

function parseCount(record: Record<string, unknown>): GrepCountOutput | undefined {
  if (!Array.isArray(record.counts)) return undefined;
  const counts: { path: string; count: number }[] = [];
  for (const rawCount of record.counts) {
    const entry = asRecord(rawCount);
    const path = entry ? stringField(entry, "path") : undefined;
    const count = entry ? numberField(entry, "count") : undefined;
    if (path === undefined || count === undefined) return undefined;
    counts.push({ path, count });
  }
  return { type: "count", counts, truncated: record.truncated === true };
}

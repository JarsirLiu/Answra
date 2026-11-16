/** Grep 的结构化输出、ripgrep JSON 解析与模型可见投影；不执行搜索。 */

export const GREP_DEFAULT_HEAD_LIMIT = 250;
export const GREP_MAX_OUTPUT_BYTES = 20_000;
export const GREP_MAX_LINE_CHARS = 500;

export type GrepOutputMode = "content" | "files_with_matches" | "count";

export interface GrepLine {
  readonly lineNumber: number;
  readonly text: string;
  readonly kind: "match" | "context";
}

export interface GrepFileContent {
  readonly path: string;
  readonly lines: readonly GrepLine[];
}

export interface GrepContentOutput {
  readonly type: "content";
  readonly files: readonly GrepFileContent[];
  readonly totalMatches: number;
  readonly shownMatches: number;
  readonly truncated: boolean;
  readonly lineNumbers: boolean;
}

export interface GrepFilesOutput {
  readonly type: "files_with_matches";
  readonly files: readonly string[];
  readonly truncated: boolean;
}

export interface GrepCountOutput {
  readonly type: "count";
  readonly counts: readonly { readonly path: string; readonly count: number }[];
  readonly truncated: boolean;
}

export type GrepOutput = GrepContentOutput | GrepFilesOutput | GrepCountOutput;

interface GrepMatchRecord {
  readonly path: string;
  readonly lineNumber: number;
  readonly lines: readonly string[];
  readonly submatches: readonly string[];
}

interface GrepFileState {
  readonly matches: GrepMatchRecord[];
  readonly lines: Map<number, GrepLine>;
}

export interface ParseGrepOutputOptions {
  readonly afterContext: number;
  readonly beforeContext: number;
  readonly headLimit: number;
  readonly lineNumbers: boolean;
  readonly offset: number;
  readonly onlyMatching: boolean;
  readonly outputMode: GrepOutputMode;
}

interface RipgrepJsonEvent {
  readonly type: string;
  readonly data?: {
    readonly line_number?: number;
    readonly lines?: { readonly text?: string };
    readonly path?: { readonly text?: string };
    readonly submatches?: readonly {
      readonly match?: { readonly text?: string };
    }[];
  };
}

export function parseGrepOutput(stdout: string, options: ParseGrepOutputOptions): GrepOutput {
  const files = new Map<string, GrepFileState>();
  const matches: GrepMatchRecord[] = [];

  for (const rawLine of stdout.split("\n")) {
    if (!rawLine.trim()) continue;
    let event: RipgrepJsonEvent;
    try {
      event = JSON.parse(rawLine) as RipgrepJsonEvent;
    } catch {
      continue;
    }
    if (event.type !== "match" && event.type !== "context") continue;
    const filePath = normalizePath(event.data?.path?.text);
    const lineText = event.data?.lines?.text;
    if (!filePath || lineText === undefined) continue;
    const lineNumber = normalizeLineNumber(event.data?.line_number);
    const textLines = splitEventLines(lineText);
    const file = getFile(files, filePath);

    if (event.type === "context") {
      addLines(file, lineNumber, textLines, "context");
      continue;
    }

    const submatches = (event.data?.submatches ?? [])
      .map((submatch) => submatch.match?.text)
      .filter((text): text is string => text !== undefined);
    const match: GrepMatchRecord = {
      path: filePath,
      lineNumber,
      lines: textLines,
      submatches,
    };
    matches.push(match);
    file.matches.push(match);
    if (options.onlyMatching && submatches.length > 0) {
      addMatchSubmatches(file, lineNumber, submatches);
    } else {
      addLines(file, lineNumber, textLines, "match");
    }
  }

  const outputLimit = options.headLimit === 0 ? Number.POSITIVE_INFINITY : options.headLimit;
  switch (options.outputMode) {
    case "files_with_matches": {
      const uniquePaths = [...new Set(matches.map((match) => match.path))];
      const selected = uniquePaths.slice(options.offset, options.offset + outputLimit);
      return {
        type: "files_with_matches",
        files: selected,
        truncated: uniquePaths.length > options.offset + selected.length,
      };
    }
    case "count": {
      const counts = new Map<string, number>();
      for (const match of matches) counts.set(match.path, (counts.get(match.path) ?? 0) + 1);
      const entries = [...counts.entries()];
      const selected = entries.slice(options.offset, options.offset + outputLimit);
      return {
        type: "count",
        counts: selected.map(([path, count]) => ({ path, count })),
        truncated: entries.length > options.offset + selected.length,
      };
    }
    case "content": {
      const selectedMatches = matches.slice(options.offset, options.offset + outputLimit);
      const selectedByFile = new Map<string, GrepMatchRecord[]>();
      for (const match of selectedMatches) {
        const existing = selectedByFile.get(match.path);
        if (existing) existing.push(match);
        else selectedByFile.set(match.path, [match]);
      }
      const content = [...selectedByFile.entries()].map(([filePath, fileMatches]) => ({
        path: filePath,
        lines: selectContentLines(files.get(filePath), fileMatches, options),
      }));
      return {
        type: "content",
        files: content,
        totalMatches: matches.length,
        shownMatches: selectedMatches.length,
        truncated: matches.length > options.offset + selectedMatches.length,
        lineNumbers: options.lineNumbers,
      };
    }
  }
}

export function formatGrepOutput(output: GrepOutput): string {
  switch (output.type) {
    case "files_with_matches":
      return formatFilesOutput(output);
    case "count":
      return formatCountOutput(output);
    case "content":
      return formatContentOutput(output);
  }
}

function formatFilesOutput(output: GrepFilesOutput): string {
  if (output.files.length === 0) return "未找到匹配内容";
  return `${output.files.join("\n")}${output.truncated ? "\n[结果达到上限]" : ""}`;
}

function formatCountOutput(output: GrepCountOutput): string {
  if (output.counts.length === 0) return "未找到匹配内容";
  const rows = output.counts.map(({ path, count }) => `${path}:${count}`);
  return `${rows.join("\n")}${output.truncated ? "\n[结果达到上限]" : ""}`;
}

function formatContentOutput(output: GrepContentOutput): string {
  if (output.files.length === 0) return "未找到匹配内容";
  const groups: string[] = [];
  for (const file of output.files) {
    let previousLine: number | undefined;
    for (const line of file.lines) {
      if (previousLine !== undefined && line.lineNumber !== previousLine + 1) groups.push("--");
      groups.push(formatLine(file.path, line, output.lineNumbers));
      previousLine = line.lineNumber;
    }
    groups.push("--");
  }
  if (groups.at(-1) === "--") groups.pop();
  return `${groups.join("\n")}${output.truncated ? "\n[结果达到上限]" : ""}`;
}

function formatLine(path: string, line: GrepLine, lineNumbers: boolean): string {
  const separator = line.kind === "match" ? ":" : "-";
  const text = truncateLine(line.text);
  return lineNumbers
    ? `${path}${separator}${line.lineNumber}${separator}${text}`
    : `${path}${separator}${text}`;
}

function selectContentLines(
  file: GrepFileState | undefined,
  matches: readonly GrepMatchRecord[],
  options: ParseGrepOutputOptions,
): GrepLine[] {
  if (!file) return [];
  const selected = new Map<number, GrepLine>();
  for (const match of matches) {
    const endLine = match.lineNumber + Math.max(1, match.lines.length) - 1;
    for (const [lineNumber, line] of file.lines) {
      if (lineNumber < match.lineNumber - options.beforeContext) continue;
      if (lineNumber > endLine + options.afterContext) continue;
      selected.set(lineNumber, line);
    }
  }
  return [...selected.values()].sort((left, right) => left.lineNumber - right.lineNumber);
}

function getFile(files: Map<string, GrepFileState>, filePath: string): GrepFileState {
  const existing = files.get(filePath);
  if (existing) return existing;
  const created: GrepFileState = { matches: [], lines: new Map() };
  files.set(filePath, created);
  return created;
}

function addMatchSubmatches(
  file: GrepFileState,
  lineNumber: number,
  submatches: readonly string[],
): void {
  let offset = 0;
  for (const submatch of submatches) {
    const lines = splitEventLines(submatch);
    addLines(file, lineNumber + offset, lines, "match");
    offset += Math.max(1, lines.length) - 1;
  }
}

function addLines(
  file: GrepFileState,
  startLine: number,
  lines: readonly string[],
  kind: GrepLine["kind"],
): void {
  lines.forEach((text, index) => {
    const lineNumber = startLine + index;
    const existing = file.lines.get(lineNumber);
    if (existing?.kind === "match" && kind === "context") return;
    file.lines.set(lineNumber, { lineNumber, text, kind });
  });
}

function normalizePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function normalizeLineNumber(value: number | undefined): number {
  return value === undefined ? 1 : Math.max(1, Math.trunc(value));
}

function splitEventLines(value: string): string[] {
  const normalized = value.replaceAll("\r\n", "\n");
  const withoutTrailingNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return withoutTrailingNewline.split("\n");
}

function truncateLine(value: string): string {
  return value.length > GREP_MAX_LINE_CHARS ? `${value.slice(0, GREP_MAX_LINE_CHARS)}…` : value;
}

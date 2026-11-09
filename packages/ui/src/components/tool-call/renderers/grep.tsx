import { Search } from "lucide-react";
import type { ReactNode } from "react";
import { ToolCallCard } from "../ToolCallCard";
import { ToolDetailSection, ToolErrorBlock, ToolNotice, ToolOutputBlock } from "../ToolCallDetails";
import styles from "../toolCallContent.module.css";
import type { ToolCallRendererProps } from "../toolCallPart";
import {
  asRecord,
  clipText,
  formatToolValue,
  MAX_TOOL_VALUE_CHARS,
  numberField,
  stringField,
} from "../toolCallPresentation";

const MAX_GREP_FILES = 20;
const MAX_GREP_LINES = 120;

interface GrepLine {
  lineNumber: number;
  text: string;
  kind: "match" | "context";
}

interface GrepFileContent {
  path: string;
  lines: GrepLine[];
}

interface GrepContentOutput {
  files: GrepFileContent[];
  totalMatches: number;
  shownMatches: number;
  truncated: boolean;
  lineNumbers: boolean;
}

interface GrepFilesOutput {
  files: string[];
  truncated: boolean;
}

interface GrepCountOutput {
  counts: { path: string; count: number }[];
  truncated: boolean;
}

/** Grep: pattern in the summary; content/files/count result groups in the details. */
export function GrepToolCall({ part }: ToolCallRendererProps) {
  const input = asRecord(part.input);
  const pattern = input ? stringField(input, "pattern") : undefined;
  const inputPath = input ? stringField(input, "path") : undefined;
  const glob = input ? stringField(input, "glob") : undefined;
  const type = input ? stringField(input, "type") : undefined;
  const content = parseContentOutput(part.output);
  const files = parseFilesOutput(part.output);
  const counts = parseCountOutput(part.output);
  const error = part.errorText ? clipText(part.errorText, MAX_TOOL_VALUE_CHARS) : undefined;
  const malformed =
    part.output !== undefined && !content && !files && !counts
      ? clipText(formatToolValue(part.output), MAX_TOOL_VALUE_CHARS)
      : undefined;
  const meta = content
    ? `${content.totalMatches} 处匹配`
    : files
      ? `${files.files.length} 个文件`
      : counts
        ? `${counts.counts.length} 个文件`
        : undefined;
  const scope =
    [inputPath, glob ? `glob:${glob}` : undefined, type ? `type:${type}` : undefined]
      .filter(Boolean)
      .join(" · ") || undefined;
  const hasDetails =
    error !== undefined ||
    content !== undefined ||
    files !== undefined ||
    counts !== undefined ||
    malformed !== undefined;

  return (
    <ToolCallCard
      actionLabel="搜索"
      icon={<Search size={13} />}
      meta={meta}
      part={part}
      primary={pattern ?? part.title ?? "搜索"}
      secondary={scope}
    >
      {hasDetails ? (
        <>
          {error ? <ToolErrorBlock text={error.text} /> : null}
          {content ? <ContentDetails output={content} /> : null}
          {files ? <FilesDetails output={files} /> : null}
          {counts ? <CountDetails output={counts} /> : null}
          {malformed ? (
            <ToolDetailSection label="结果">
              <ToolOutputBlock text={malformed.text} />
            </ToolDetailSection>
          ) : null}
        </>
      ) : undefined}
    </ToolCallCard>
  );
}

function ContentDetails({ output }: { output: GrepContentOutput }) {
  let remainingLines = MAX_GREP_LINES;
  const totalLines = output.files.reduce((sum, file) => sum + file.lines.length, 0);
  const groups: ReactNode[] = [];

  for (const file of output.files.slice(0, MAX_GREP_FILES)) {
    if (remainingLines <= 0) break;
    const lines = file.lines.slice(0, remainingLines);
    remainingLines -= lines.length;
    groups.push(
      <div className={styles.file} key={file.path}>
        <div className={styles.fileHeader}>{file.path}</div>
        <div className={styles.lines}>
          {lines.map((line) => (
            <div
              className={styles.line}
              data-kind={line.kind}
              key={`${file.path}:${line.lineNumber}`}
            >
              {output.lineNumbers ? (
                <span className={styles.lineNumber}>{line.lineNumber}</span>
              ) : null}
              <span>{line.text}</span>
            </div>
          ))}
        </div>
      </div>,
    );
  }

  const shownLines = MAX_GREP_LINES - remainingLines;
  const truncated =
    output.truncated || output.files.length > MAX_GREP_FILES || shownLines < totalLines;

  return (
    <ToolDetailSection label="匹配">
      {groups.length > 0 ? groups : <ToolNotice>未找到匹配内容。</ToolNotice>}
      {truncated ? (
        <ToolNotice>
          已截断：显示 {shownLines} / {totalLines} 行。
        </ToolNotice>
      ) : null}
    </ToolDetailSection>
  );
}

function FilesDetails({ output }: { output: GrepFilesOutput }) {
  if (output.files.length === 0) {
    return <ToolNotice>未找到匹配文件。</ToolNotice>;
  }
  const shown = output.files.slice(0, MAX_GREP_FILES);
  return (
    <ToolDetailSection label="文件">
      <ToolOutputBlock text={shown.join("\n")} />
      {output.truncated || shown.length < output.files.length ? (
        <ToolNotice>
          已截断：显示 {shown.length} / {output.files.length} 个文件。
        </ToolNotice>
      ) : null}
    </ToolDetailSection>
  );
}

function CountDetails({ output }: { output: GrepCountOutput }) {
  if (output.counts.length === 0) {
    return <ToolNotice>未找到匹配文件。</ToolNotice>;
  }
  const shown = output.counts.slice(0, MAX_GREP_FILES);
  return (
    <ToolDetailSection label="计数">
      <div className={styles.lines}>
        {shown.map((entry) => (
          <div className={styles.countRow} key={entry.path}>
            <span>{entry.path}</span>
            <span className={styles.countValue}>{entry.count}</span>
          </div>
        ))}
      </div>
      {output.truncated || shown.length < output.counts.length ? (
        <ToolNotice>
          已截断：显示 {shown.length} / {output.counts.length} 个文件。
        </ToolNotice>
      ) : null}
    </ToolDetailSection>
  );
}

function parseContentOutput(value: unknown): GrepContentOutput | undefined {
  const record = asRecord(value);
  if (record?.type !== "content" || !Array.isArray(record.files)) return undefined;
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
    files,
    totalMatches: numberField(record, "totalMatches") ?? 0,
    shownMatches: numberField(record, "shownMatches") ?? 0,
    truncated: record.truncated === true,
    lineNumbers: record.lineNumbers === true,
  };
}

function parseFilesOutput(value: unknown): GrepFilesOutput | undefined {
  const record = asRecord(value);
  if (record?.type !== "files_with_matches" || !Array.isArray(record.files)) return undefined;
  const files = record.files.filter((file): file is string => typeof file === "string");
  if (files.length !== record.files.length) return undefined;
  return { files, truncated: record.truncated === true };
}

function parseCountOutput(value: unknown): GrepCountOutput | undefined {
  const record = asRecord(value);
  if (record?.type !== "count" || !Array.isArray(record.counts)) return undefined;
  const counts: { path: string; count: number }[] = [];
  for (const rawCount of record.counts) {
    const entry = asRecord(rawCount);
    const path = entry ? stringField(entry, "path") : undefined;
    const count = entry ? numberField(entry, "count") : undefined;
    if (path === undefined || count === undefined) return undefined;
    counts.push({ path, count });
  }
  return { counts, truncated: record.truncated === true };
}

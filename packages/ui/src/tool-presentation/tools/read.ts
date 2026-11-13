/** Read presenter: summary plus a `Read N lines` result; never file contents. */
import type { ToolPresentation, ToolPresenterContext } from "../types";
import { asRecord, directoryName, fileName, numberField, stringField } from "../value";

const FILE_UNCHANGED_PREFIX = "Wasted call";
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/gu;
const LINE_NUMBER_PREFIX = /^\d+\t/u;

export function presentRead(context: ToolPresenterContext): ToolPresentation {
  const input = asRecord(context.input);
  const inputPath = input
    ? (stringField(input, "file_path") ?? stringField(input, "path"))
    : undefined;
  const output = asRecord(context.output);
  const outputType = output ? stringField(output, "type") : undefined;
  const outputPath = output ? stringField(output, "filePath") : undefined;
  const path = inputPath ?? outputPath;
  const primary = path ? fileName(path) : (context.title ?? "file");
  const secondary = path ? directoryName(path) : undefined;
  const resultLine = readResultLine(outputType, output, context.output);

  return {
    toolName: context.toolName,
    action: "read",
    category: "read",
    state: context.state,
    primary,
    ...(secondary ? { secondary } : {}),
    ...(resultLine ? { resultLine } : {}),
    ...(context.errorText ? { errorText: context.errorText } : {}),
    details: [],
    expandable: false,
  };
}

function readResultLine(
  outputType: string | undefined,
  output: Record<string, unknown> | undefined,
  raw: unknown,
): string | undefined {
  if (outputType === "file_unchanged") return "Unchanged since last read";
  if (outputType === "text") {
    const numLines = output ? (numberField(output, "numLines") ?? 0) : 0;
    return `Read ${numLines} ${numLines === 1 ? "line" : "lines"}`;
  }
  if (typeof raw !== "string") return undefined;
  if (raw.startsWith(FILE_UNCHANGED_PREFIX)) return "Unchanged since last read";
  const lines = countLegacyReadLines(raw);
  return lines === undefined ? undefined : `Read ${lines} ${lines === 1 ? "line" : "lines"}`;
}

function countLegacyReadLines(output: string): number | undefined {
  const withoutReminders = output.replace(SYSTEM_REMINDER, "").trim();
  if (withoutReminders.length === 0) return 0;
  const lines = withoutReminders.split("\n");
  return lines.every((line) => LINE_NUMBER_PREFIX.test(line)) ? lines.length : undefined;
}

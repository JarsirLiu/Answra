/** Skill presenter: skill name in the header, load stats on one line, body behind an expand. */
import { clipDetailText } from "../limits";
import type { ToolPresentation, ToolPresenterContext } from "../types";
import { asRecord, stringField } from "../value";

const SKILL_OPEN = /^<skill_content(?:\s+name="([^"]*)")?>\s*$/u;
const SKILL_CLOSE = /^<\/skill_content>\s*$/u;
const SKILL_TITLE = /^#\s+.+$/u;
const BASE_DIRECTORY = /^Base directory for this skill:/u;
const TRUNCATION_NOTE = /^Note: content truncated/u;

export function presentSkill(context: ToolPresenterContext): ToolPresentation {
  const lines = typeof context.output === "string" ? context.output.split(/\r?\n/u) : [];
  const input = asRecord(context.input);
  const name = stringField(input ?? {}, "name") ?? outputName(lines) ?? context.title ?? "skill";
  const clipped = clipDetailText(skillBody(lines).join("\n"));
  const files = countFiles(lines);
  const truncated = lines.some((line) => TRUNCATION_NOTE.test(line));
  const resultLine =
    context.state === "completed" ? loadSummary(clipped.totalLines, files, truncated) : undefined;

  return {
    toolName: context.toolName,
    action: "other",
    category: "skill",
    state: context.state,
    primary: name,
    ...(resultLine ? { resultLine } : {}),
    ...(context.errorText ? { errorText: context.errorText } : {}),
    details:
      clipped.text.length > 0
        ? [
            {
              kind: "text",
              label: "Skill content",
              text: clipped.text,
              wrap: true,
              truncated: clipped.truncated,
              totalLines: clipped.totalLines,
            },
          ]
        : [],
    expandable: clipped.text.length > 0,
  };
}

function outputName(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const match = SKILL_OPEN.exec(line);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/**
 * 去掉工具包装（`<skill_content>`、重复的标题、base directory 与文件清单），
 * 只保留 skill 正文；不是包装格式时原样展示。
 */
function skillBody(lines: readonly string[]): string[] {
  const open = lines.findIndex((line) => SKILL_OPEN.test(line));
  if (open === -1) return trimBlankLines(lines);
  const next = lines[open + 1];
  const start = open + (next !== undefined && SKILL_TITLE.test(next) ? 2 : 1);
  const end = lines.findIndex((line, index) => index > open && BASE_DIRECTORY.test(line));
  return trimBlankLines(
    lines.slice(start, end === -1 ? undefined : end).filter((line) => !SKILL_CLOSE.test(line)),
  );
}

function trimBlankLines(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start]?.trim().length ?? 0) === 0) start += 1;
  while (end > start && (lines[end - 1]?.trim().length ?? 0) === 0) end -= 1;
  return lines.slice(start, end);
}

function countFiles(lines: readonly string[]): number {
  return lines.reduce((count, line) => count + line.split("<file>").length - 1, 0);
}

function loadSummary(lines: number, files: number, truncated: boolean): string {
  const parts = [`Loaded ${lines} ${lines === 1 ? "line" : "lines"}`];
  if (files > 0) parts.push(`${files} ${files === 1 ? "file" : "files"}`);
  if (truncated) parts.push("truncated");
  return parts.join(" · ");
}

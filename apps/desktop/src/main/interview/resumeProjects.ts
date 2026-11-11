import {
  INTERVIEW_PROJECT_EVIDENCE_MAX_LENGTH,
  INTERVIEW_PROJECT_NAME_MAX_LENGTH,
  INTERVIEW_PROJECT_PERIOD_MAX_LENGTH,
  INTERVIEW_PROJECT_ROLE_MAX_LENGTH,
  INTERVIEW_PROJECT_SUMMARY_MAX_LENGTH,
  INTERVIEW_PROJECTS_MAX,
} from "@answra/shared";

export interface ParsedResumeProject {
  name: string;
  role?: string;
  period?: string;
  summary?: string;
  evidence?: string;
}

const PROJECT_SECTION_TITLES = new Set([
  "项目经历",
  "项目经验",
  "项目",
  "projects",
  "project",
  "project experience",
  "selected projects",
]);

const OTHER_SECTION_TITLES = new Set([
  "教育经历",
  "教育背景",
  "工作经历",
  "工作经验",
  "实习经历",
  "校园经历",
  "技能",
  "专业技能",
  "技能特长",
  "自我评价",
  "个人总结",
  "荣誉",
  "证书",
  "获奖经历",
  "education",
  "experience",
  "work experience",
  "skills",
  "summary",
]);

const MARKDOWN_HEADING = /^\s{0,3}(#{1,6})\s*(.+?)\s*$/;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/;
const DATE_RANGE =
  /(?:19|20)\d{2}(?:\s*[./年-]\s*\d{1,2})?\s*(?:[-~至到—–]\s*(?:19|20)\d{2}(?:\s*[./年-]\s*\d{1,2})?)?/;
const BODY_VERB =
  /^(?:负责|参与|使用|实现|主导|完成|开发|设计|优化|搭建|维护|推动|编写|根据|通过|协助|独立|从零)/;
const SENTENCE_END = /[。；;]$/;

/**
 * Extracts project cards from a .md/.txt resume without a model call.
 * This is intentionally a heuristic: it only looks inside a project section and
 * returns an empty list rather than guessing when no reliable title is found.
 */
export function extractResumeProjects(text: string): ParsedResumeProject[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const section = findProjectSection(lines);
  if (!section) return [];
  const usesHeadings = lines
    .slice(section.start, section.end)
    .some((line) => MARKDOWN_HEADING.test(line));

  const projects: ParsedResumeProject[] = [];
  let current: { title: string; body: string[] } | undefined;

  const flush = () => {
    if (!current) return;
    const project = toProject(current.title, current.body);
    if (project && !projects.some((item) => item.name.toLowerCase() === project.name.toLowerCase()))
      projects.push(project);
    current = undefined;
  };

  for (let index = section.start; index < section.end; index += 1) {
    const line = lines[index] ?? "";
    const heading = MARKDOWN_HEADING.exec(line);
    if (heading?.[2] && !PROJECT_SECTION_TITLES.has(normalizeTitle(heading[2]))) {
      flush();
      current = { title: heading[2], body: [] };
      continue;
    }

    if (!usesHeadings && isPlainProjectTitle(lines, index, section.end)) {
      flush();
      current = { title: line.trim(), body: [] };
      continue;
    }

    if (current) current.body.push(line);
  }
  flush();

  return projects.slice(0, INTERVIEW_PROJECTS_MAX);
}

function findProjectSection(
  lines: readonly string[],
): { start: number; end: number; level: number } | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heading = MARKDOWN_HEADING.exec(line);
    if (heading?.[1] && heading[2] && PROJECT_SECTION_TITLES.has(normalizeTitle(heading[2]))) {
      const level = heading[1].length;
      return {
        start: index + 1,
        end: findSectionEnd(lines, index + 1, level),
        level,
      };
    }
    const plain = normalizeTitle(line);
    if (PROJECT_SECTION_TITLES.has(plain)) {
      return {
        start: index + 1,
        end: findPlainSectionEnd(lines, index + 1),
        level: 0,
      };
    }
  }
  return undefined;
}

function findSectionEnd(lines: readonly string[], start: number, level: number): number {
  for (let index = start; index < lines.length; index += 1) {
    const heading = MARKDOWN_HEADING.exec(lines[index] ?? "");
    if (heading?.[1] && heading[1].length <= level) return index;
  }
  return lines.length;
}

function findPlainSectionEnd(lines: readonly string[], start: number): number {
  for (let index = start; index < lines.length; index += 1) {
    if (OTHER_SECTION_TITLES.has(normalizeTitle(lines[index] ?? ""))) return index;
  }
  return lines.length;
}

function isPlainProjectTitle(lines: readonly string[], index: number, end: number): boolean {
  const line = lines[index] ?? "";
  const trimmed = line.trim();
  if (!trimmed || BULLET.test(line) || MARKDOWN_HEADING.test(line)) return false;
  if (PROJECT_SECTION_TITLES.has(normalizeTitle(trimmed))) return false;
  if (trimmed.length > INTERVIEW_PROJECT_NAME_MAX_LENGTH) return false;
  if (BODY_VERB.test(trimmed) || SENTENCE_END.test(trimmed)) return false;

  const next = nextNonEmptyLine(lines, index + 1, end);
  if (!next) return false;
  if (BULLET.test(next)) return true;
  if (DATE_RANGE.test(trimmed)) return true;
  return !trimmed.includes("：") && !trimmed.includes(":") && trimmed.length <= 40;
}

function nextNonEmptyLine(
  lines: readonly string[],
  start: number,
  end: number,
): string | undefined {
  for (let index = start; index < end; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim()) return line;
  }
  return undefined;
}

function toProject(title: string, body: readonly string[]): ParsedResumeProject | undefined {
  const { name, role, period } = splitTitle(title);
  if (!name) return undefined;
  const bodyLines = body.map(cleanLine).filter((line) => line.length > 0);
  const summary = bodyLines.slice(0, 2).join("；").slice(0, INTERVIEW_PROJECT_SUMMARY_MAX_LENGTH);
  const evidence = bodyLines.join("\n").slice(0, INTERVIEW_PROJECT_EVIDENCE_MAX_LENGTH);
  return {
    name,
    ...(role ? { role } : {}),
    ...(period ? { period } : {}),
    ...(summary ? { summary } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

function splitTitle(title: string): {
  name: string;
  role?: string;
  period?: string;
} {
  const parts = title
    .split(/[|｜]/)
    .map((part) => part.trim())
    .filter(Boolean);
  const name = (parts[0] ?? title.trim()).slice(0, INTERVIEW_PROJECT_NAME_MAX_LENGTH);
  let role: string | undefined;
  let period: string | undefined;
  for (const part of parts.slice(1)) {
    if (DATE_RANGE.test(part)) period = part.slice(0, INTERVIEW_PROJECT_PERIOD_MAX_LENGTH);
    else if (!role) role = part.slice(0, INTERVIEW_PROJECT_ROLE_MAX_LENGTH);
  }
  return { name, ...(role ? { role } : {}), ...(period ? { period } : {}) };
}

function cleanLine(line: string): string {
  const bullet = BULLET.exec(line);
  return (bullet?.[1] ?? line).trim();
}

function normalizeTitle(value: string): string {
  return value
    .replace(/^#+\s*/, "")
    .replace(/[：:]\s*$/, "")
    .trim()
    .toLowerCase();
}

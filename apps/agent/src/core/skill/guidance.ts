/**
 * Skill 索引渲染：把 skill 列表压成 system prompt 中的 <available_skills> 片段。
 * 只读 SkillInfo，不读文件、不扫描目录，也不做 profile 白名单过滤（由调用方先过滤）。
 */
import { SKILL_DESCRIPTION_MAX_CHARS, SKILL_INDEX_MAX_ENTRIES, type SkillInfo } from "./contracts";

const INDEX_HEADER = [
  "Skills provide specialized instructions and workflows for specific tasks.",
  "Call the Skill tool with a skill name when the task matches its description.",
];

/** 白名单过滤：profile 声明的名单是唯一授权来源，未声明即不可见。 */
export function selectSkills(
  skills: readonly SkillInfo[],
  allowed: readonly string[] | undefined,
): readonly SkillInfo[] {
  if (!allowed || allowed.length === 0) return [];
  const allowSet = new Set(allowed);
  return skills.filter((skill) => allowSet.has(skill.name));
}

/**
 * 渲染索引文本；无可用 skill 时返回空字符串，调用方据此跳过拼接。
 * 超出条数上限时按 name 排序取前 N，并显式告知模型列表被截断。
 */
export function renderSkillIndex(skills: readonly SkillInfo[]): string {
  if (skills.length === 0) return "";

  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  const shown = sorted.slice(0, SKILL_INDEX_MAX_ENTRIES);
  const omitted = sorted.length - shown.length;

  return [
    ...INDEX_HEADER,
    "",
    "<available_skills>",
    ...shown.flatMap((skill) => [
      "  <skill>",
      `    <name>${skill.name}</name>`,
      `    <description>${truncate(skill.description, SKILL_DESCRIPTION_MAX_CHARS)}</description>`,
      "  </skill>",
    ]),
    "</available_skills>",
    ...(omitted > 0
      ? ["", `Note: ${omitted} more skill(s) are not listed here due to the index size limit.`]
      : []),
  ].join("\n");
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…`;
}

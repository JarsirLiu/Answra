/**
 * Skill 工具：按名称从预构建的 skill 表取出正文与同目录文件清单。
 * 入参只有 name，绝不接受路径——查表天然免疫 ../ 一类的目录穿越。
 */
import { promises as fs } from "node:fs";
import type { JSONSchema7 } from "ai";
import type { SkillCatalog } from "../../../skill/catalog";
import {
  SKILL_CONTENT_MAX_CHARS,
  SKILL_FILE_LIST_MAX_ENTRIES,
  type SkillRoots,
} from "../../../skill/contracts";
import { defineTool, type ToolHandlerFailure } from "../../contracts";
import { assertNotAborted } from "../../executor/abort";
import { SKILL_TOOL_ID } from "../../ids";
import { SKILL_TOOL_NAME } from "../../names";

interface SkillToolInput {
  name: string;
}

interface SkillToolOutput {
  readonly name: string;
  readonly directory: string;
  readonly files: readonly string[];
  readonly content: string;
  readonly truncated: boolean;
}

/**
 * 工具输出完整 JSON 的字节上限。执行器在 formatModelContent 之后先按此硬性拒绝
 * （output-too-large），再用 resultBudget 二次截断。正文长度由本工具的
 * SKILL_CONTENT_MAX_CHARS 控制，这里与 resultBudget 都要容纳截断标记、
 * base directory 与文件清单的包装开销，避免第二层截断吃掉本工具的截断提示。
 */
const SKILL_OUTPUT_PACKAGING_RESERVE_BYTES = 8_192;
const SKILL_OUTPUT_MAX_BYTES = SKILL_CONTENT_MAX_CHARS * 4 + SKILL_OUTPUT_PACKAGING_RESERVE_BYTES;
const SKILL_OUTPUT_MAX_CHARS = SKILL_CONTENT_MAX_CHARS + SKILL_OUTPUT_PACKAGING_RESERVE_BYTES;

const SKILL_TOOL_DESCRIPTION = [
  "Loads a specialized skill whose instructions are needed for the current task.",
  "",
  "- `name` must match one skill listed in the available skills section of the system prompt.",
  "- Returns the skill's instructions plus its base directory and a sample of sibling files.",
  "- Relative paths inside a skill (e.g. templates/, reference/) resolve against that base directory.",
  "- Calling this for a name that is not in the available list is an error.",
].join("\n");

const SKILL_INPUT_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    name: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description: "The name of a skill from the available skills list.",
    },
  },
  required: ["name"],
  additionalProperties: false,
};

/**
 * catalog 由组合根注入；工具自身不扫描目录、不知道物理来源。
 * 未注入时工具不注册，索引也为空（不静默降级到猜测目录）。
 */
export function createSkillTool(catalog: SkillCatalog) {
  return defineTool<SkillToolInput, SkillToolOutput>({
    id: SKILL_TOOL_ID,
    metadata: {
      name: SKILL_TOOL_NAME,
      description: SKILL_TOOL_DESCRIPTION,
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      sideEffectScope: "none",
      timeoutMs: 30_000,
      maxOutputBytes: SKILL_OUTPUT_MAX_BYTES,
      resultBudget: { strategy: "truncate", maxModelChars: SKILL_OUTPUT_MAX_CHARS },
    },
    inputSchema: SKILL_INPUT_SCHEMA,
    handler: (input, context) => loadSkill(catalog, input, context.signal),
    formatModelContent: formatSkillOutput,
  });
}

async function loadSkill(
  catalog: SkillCatalog,
  input: SkillToolInput,
  signal: AbortSignal,
): Promise<SkillToolOutput | ToolHandlerFailure> {
  assertNotAborted(signal);
  const skill = catalog.find(input.name);
  if (!skill) {
    return {
      ok: false,
      code: "invalid-input",
      message: createUnknownSkillMessage(catalog, input.name),
    };
  }

  const files = await listSiblingFiles(skill.directory);
  assertNotAborted(signal);

  const truncated = skill.content.length > SKILL_CONTENT_MAX_CHARS;
  return {
    name: skill.name,
    directory: skill.directory,
    files,
    content: truncated ? skill.content.slice(0, SKILL_CONTENT_MAX_CHARS) : skill.content,
    truncated,
  };
}

function createUnknownSkillMessage(catalog: SkillCatalog, requested: string): string {
  const available = catalog.list().map((skill) => skill.name);
  if (available.length === 0) {
    return `没有可用的 skill，无法加载「${requested}」。来源：${describeSkillRoots(catalog.roots())}。`;
  }
  return `未知 skill「${requested}」。可用 skill：${available.join("、")}。`;
}

/** 空 catalog 时把宿主注入的来源原样告诉模型，避免把"扫错目录"误判成"没有 skill"。 */
function describeSkillRoots(roots: SkillRoots): string {
  return [
    `内置=${roots.builtin ?? "无"}`,
    `用户=${roots.user ?? "无"}`,
    `工作区=${roots.workspaceRoot ? `${roots.workspaceRoot}（含向上至项目根各层）` : "无"}`,
  ].join("；");
}

/** 只列同目录内的文件相对路径，不递归、不读内容。 */
async function listSiblingFiles(directory: string): Promise<readonly string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name !== "SKILL.md")
      .map((entry) => entry.name)
      .sort()
      .slice(0, SKILL_FILE_LIST_MAX_ENTRIES);
  } catch {
    // 列目录失败不影响加载正文本身。
    return [];
  }
}

export function formatSkillOutput(output: SkillToolOutput): string {
  return [
    `<skill_content name="${output.name}">`,
    `# ${output.name}`,
    "",
    output.content,
    ...(output.truncated
      ? ["", `Note: content truncated to ${SKILL_CONTENT_MAX_CHARS} characters.`]
      : []),
    "",
    `Base directory for this skill: ${output.directory}`,
    "Relative paths in this skill (e.g. templates/, reference/) are relative to this base directory.",
    ...(output.files.length > 0
      ? [
          "",
          "<skill_files>",
          ...output.files.map((file) => `  <file>${file}</file>`),
          "</skill_files>",
        ]
      : []),
    "</skill_content>",
  ].join("\n");
}

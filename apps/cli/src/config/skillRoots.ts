/**
 * CLI 宿主的 skill 目录解析：agent 不认识物理路径，这里把三类根目录算出来再注入。
 * 不存在或不可用的来源一律给 null，由 agent 按"该来源没有 skill"处理，不做兜底猜测。
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillRoots } from "@answra/agent/composition";
import { resolveDefaultConfigDir } from "@answra/config";

/** 工作区内的开发者/项目 skill 目录。 */
const WORKSPACE_SKILL_DIR = [".agents", "skills"];

/** 用户级 skill 目录，位于 CLI 配置目录下，跨项目复用。 */
const USER_SKILL_DIR = ["skills"];

/** 打包时由 build 脚本复制到 dist/skills，与本模块同级的 dist 目录下。 */
const BUNDLED_SKILL_DIR = ["skills"];

export function resolveCliSkillRoots(workspaceRoot: string | null): SkillRoots {
  return {
    builtin: existingDirectory(resolveBundledSkillsRoot()),
    user: existingDirectory(join(resolveDefaultConfigDir(), ...USER_SKILL_DIR)),
    workspace: workspaceRoot
      ? existingDirectory(join(workspaceRoot, ...WORKSPACE_SKILL_DIR))
      : null,
  };
}

/**
 * 内置 skill 在 dist/ 下，与本文件编译产物平级。
 * 源码运行（tsx）时不存在，返回 null —— 不猜测仓库内的 packages/skills 位置。
 */
function resolveBundledSkillsRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), ...BUNDLED_SKILL_DIR);
}

function existingDirectory(candidate: string): string | null {
  return existsSync(candidate) ? candidate : null;
}

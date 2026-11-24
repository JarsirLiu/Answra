/**
 * CLI 宿主的 skill 目录解析：agent 不认识物理路径，这里把三类来源算出来再注入。
 * 不存在或不可用的来源一律给 null，由 agent 按"该来源没有 skill"处理，不做兜底猜测。
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillRoots } from "@answra/agent/composition";
import { resolveDefaultConfigDir } from "@answra/config";

/** 用户级 skill 目录，位于 CLI 配置目录下，跨项目复用。 */
const USER_SKILL_DIR = ["skills"];

/** 打包时由 build 脚本复制到 dist/skills，与本模块同级的 dist 目录下。 */
const BUNDLED_SKILL_DIR = ["skills"];

export function resolveCliSkillRoots(workspaceRoot: string | null): SkillRoots {
  return {
    builtin: resolveBuiltinSkillsRoot(),
    user: existingDirectory(join(resolveDefaultConfigDir(), ...USER_SKILL_DIR)),
    workspaceRoot,
  };
}

/**
 * 内置 skill：打包后优先 dist/skills（build 从 @answra/skills 复制）。
 * 源码运行（tsx）没有 dist 目录，回退到工作区依赖 @answra/skills 的包目录。
 */
function resolveBuiltinSkillsRoot(): string | null {
  const bundled = existingDirectory(
    join(dirname(fileURLToPath(import.meta.url)), ...BUNDLED_SKILL_DIR),
  );
  return bundled ?? resolveSkillsPackageRoot();
}

function resolveSkillsPackageRoot(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return existingDirectory(dirname(require.resolve("@answra/skills/package.json")));
  } catch {
    return null;
  }
}

function existingDirectory(candidate: string): string | null {
  return existsSync(candidate) ? candidate : null;
}

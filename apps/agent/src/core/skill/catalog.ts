/**
 * Skill 目录扫描：遍历三类来源、解析 frontmatter、校验路径安全并按优先级合并同名 skill。
 * 不做索引渲染、不读 profile 策略、不缓存——缓存由调用方按会话持有。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  SKILL_FILE_MAX_BYTES,
  SKILL_SOURCE_PRECEDENCE,
  type SkillInfo,
  type SkillRoots,
  type SkillSourceKind,
} from "./contracts";
import { parseSkillDocument } from "./frontmatter";

/** skill 文件的两种合法形态：来源根下的 `<name>.md`，或子目录内的 `SKILL.md`。 */
const SKILL_FILE_BASENAME = "SKILL.md";

/** 按契约顺序遍历的来源；顺序即优先级由低到高，后者覆盖前者。 */
const SOURCE_ORDER: readonly SkillSourceKind[] = ["builtin", "user", "workspace"];

export interface SkillCatalog {
  /** 合并后的 skill，按 name 升序；同名只保留最高优先级的来源。 */
  list(): readonly SkillInfo[];
  /** 按 name 查表；未命中返回 undefined。绝不接受路径。 */
  find(name: string): SkillInfo | undefined;
}

export interface LazySkillCatalog {
  /**
   * 会话可见的 catalog。扫描在首次 prepare 前异步完成；
   * 未完成时 `list()`/`find()` 返回空，不阻塞 prepare，也不伪造内容。
   */
  readonly catalog: SkillCatalog;
  /** 等待首次扫描完成；供需要确定结果的调用方（测试、诊断）使用。 */
  ready(): Promise<readonly SkillInfo[]>;
  /**
   * 更换工作区来源并重扫。工作区根是运行时下发的（workspace-context 命令），
   * 启动时未知，因此必须支持后续替换；传 null 表示当前没有工作区。
   */
  setWorkspaceRoot(workspaceRoot: string | null): Promise<readonly SkillInfo[]>;
  /** 释放订阅，不再接受扫描结果。 */
  dispose(): void;
}

/** 工作区根下的 skill 目录；与 CLI 保持同一约定。 */
const WORKSPACE_SKILL_SEGMENTS = [".agents", "skills"];

/**
 * 启动即触发扫描，结果在到达后替换空 catalog。
 * 扫描失败按"没有 skill"处理并告警：skill 不是核心对话的必需能力。
 */
export function createLazySkillCatalog(
  roots: SkillRoots,
  onWarning?: (message: string) => void,
): LazySkillCatalog {
  let current: readonly SkillInfo[] = [];
  let disposed = false;
  let pending: SkillRoots = roots;
  let generation = 0;

  const catalog: SkillCatalog = {
    list: () => current,
    find: (name: string) => current.find((skill) => skill.name === name),
  };

  function scan(target: SkillRoots): Promise<readonly SkillInfo[]> {
    const mine = ++generation;
    return scanSkillsWithWarning(target, onWarning).then((scanned) => {
      // 迟到的扫描结果必须丢弃：工作区可能已经换了一个。
      if (!disposed && mine === generation) current = scanned;
      return current;
    });
  }

  const ready = scan(pending);

  return {
    catalog,
    ready: () => ready,
    setWorkspaceRoot: (workspaceRoot: string | null) => {
      pending = {
        ...pending,
        workspace: workspaceRoot ? path.join(workspaceRoot, ...WORKSPACE_SKILL_SEGMENTS) : null,
      };
      return scan(pending);
    },
    dispose: () => {
      disposed = true;
    },
  };
}

async function scanSkillsWithWarning(
  roots: SkillRoots,
  onWarning: ((message: string) => void) | undefined,
): Promise<readonly SkillInfo[]> {
  try {
    const catalog = await scanSkills(roots, onWarning);
    return catalog.list();
  } catch (error) {
    onWarning?.(`skill 扫描失败，按无可用 skill 处理：${describeError(error)}`);
    return [];
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 扫描全部来源；单个来源不可读或单个文件非法只跳过，不抛错。 */
export async function scanSkills(
  roots: SkillRoots,
  onWarning?: (message: string) => void,
): Promise<SkillCatalog> {
  const merged = new Map<string, SkillInfo>();

  for (const source of SOURCE_ORDER) {
    const root = roots[source];
    if (!root) continue;
    const skills = await scanSource(root, source, onWarning);
    for (const skill of skills) {
      const existing = merged.get(skill.name);
      if (
        existing &&
        SKILL_SOURCE_PRECEDENCE[existing.source] >= SKILL_SOURCE_PRECEDENCE[skill.source]
      ) {
        continue;
      }
      merged.set(skill.name, skill);
    }
  }

  const list = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  const byName = new Map(list.map((skill) => [skill.name, skill]));
  return {
    list: () => list,
    find: (name: string) => byName.get(name),
  };
}

async function scanSource(
  root: string,
  source: SkillSourceKind,
  onWarning: ((message: string) => void) | undefined,
): Promise<readonly SkillInfo[]> {
  const resolvedRoot = await resolveRealPath(root);
  if (!resolvedRoot) return [];

  let entries: string[];
  try {
    entries = await fs.readdir(resolvedRoot);
  } catch {
    // 来源目录不存在是正常状态（如用户从未创建 ~/.answra/skills）。
    return [];
  }

  const skills: SkillInfo[] = [];
  for (const entry of entries.sort()) {
    const candidate = await resolveSkillFile(resolvedRoot, entry);
    if (!candidate) continue;
    const skill = await readSkill(candidate, resolvedRoot, source, onWarning);
    if (skill) skills.push(skill);
  }
  return skills;
}

/** 定位条目对应的 skill 文件，并确认它没有通过软链接逃逸出扫描根。 */
async function resolveSkillFile(root: string, entry: string): Promise<string | undefined> {
  const entryPath = path.join(root, entry);
  const stat = await safeStat(entryPath);
  if (!stat) return undefined;

  if (stat.isDirectory()) {
    const skillFile = await resolveRealPath(path.join(entryPath, SKILL_FILE_BASENAME));
    return skillFile && isInside(root, skillFile) ? skillFile : undefined;
  }

  if (stat.isFile() && entry.toLowerCase().endsWith(".md")) {
    const real = await resolveRealPath(entryPath);
    return real && isInside(root, real) ? real : undefined;
  }

  return undefined;
}

async function readSkill(
  filePath: string,
  root: string,
  source: SkillSourceKind,
  onWarning: ((message: string) => void) | undefined,
): Promise<SkillInfo | undefined> {
  const stat = await safeStat(filePath);
  if (!stat || stat.size > SKILL_FILE_MAX_BYTES) {
    if (stat && stat.size > SKILL_FILE_MAX_BYTES) {
      onWarning?.(`skill 文件超过 ${SKILL_FILE_MAX_BYTES} 字节，已跳过：${filePath}`);
    }
    return undefined;
  }

  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }

  const parsed = parseSkillDocument(text);
  if (!parsed) {
    onWarning?.(`skill 文件缺少合法 frontmatter，已跳过：${filePath}`);
    return undefined;
  }

  const directory = path.dirname(filePath);
  const name = parsed.frontmatter.name ?? fallbackName(filePath, root);
  if (!name || name !== path.basename(name)) {
    onWarning?.(`skill 名称非法，已跳过：${filePath}`);
    return undefined;
  }

  // 无 description 的 skill 无法让模型判断何时加载，不进索引也不可调用。
  const description = parsed.frontmatter.description;
  if (!description) {
    onWarning?.(`skill 缺少 description，已跳过：${filePath}`);
    return undefined;
  }

  return { name, description, directory, content: parsed.content, source };
}

/**
 * 只在文件直接位于来源根下（`<root>/<name>.md`）时用文件名兜底；
 * 子目录形态（`<root>/<dir>/SKILL.md`）必须由 frontmatter 显式声明 name。
 */
function fallbackName(filePath: string, root: string): string | undefined {
  if (path.basename(filePath) === SKILL_FILE_BASENAME) return undefined;
  if (path.dirname(filePath) !== root) return undefined;
  return path.basename(filePath, path.extname(filePath));
}

async function safeStat(target: string) {
  try {
    return await fs.stat(target);
  } catch {
    return undefined;
  }
}

async function resolveRealPath(target: string): Promise<string | undefined> {
  try {
    return await fs.realpath(target);
  } catch {
    return undefined;
  }
}

/** 路径必须落在根目录之内（含根自身）；用相对路径判断，避免前缀字符串误判。 */
function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (relative === "") return true;
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

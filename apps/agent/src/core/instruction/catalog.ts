/**
 * AGENTS.md 发现与读取：全局文件 + 从项目根到当前工作区的逐层文件。
 * 只负责本地磁盘事实，不拼接 prompt、不持有 profile 策略。
 */
import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import {
  INSTRUCTION_FILE_MAX_BYTES,
  type InstructionFile,
  type InstructionLoader,
} from "./contracts";

const INSTRUCTION_FILE_NAME = "AGENTS.md";
const PROJECT_MARKER = ".git";

export interface InstructionLoaderOptions {
  /** 用户级指令文件绝对路径；null 表示不加载全局指令。 */
  readonly globalFile: string | null;
  /** 非致命读取问题（如文件过大）的诊断出口。 */
  readonly onWarning?: (message: string) => void;
}

export interface LoadInstructionFilesOptions extends InstructionLoaderOptions {
  readonly workspaceRoot: string | null;
}

/** 创建按次读取的加载器：AGENTS.md 修改后在下一回合即可生效。 */
export function createInstructionLoader({
  globalFile,
  onWarning,
}: InstructionLoaderOptions): InstructionLoader {
  return {
    load: (workspaceRoot) =>
      loadInstructionFiles({ globalFile, workspaceRoot, ...(onWarning ? { onWarning } : {}) }),
  };
}

export async function loadInstructionFiles({
  globalFile,
  workspaceRoot,
  onWarning,
}: LoadInstructionFilesOptions): Promise<readonly InstructionFile[]> {
  const candidates: string[] = [];
  if (globalFile) candidates.push(path.resolve(globalFile));
  if (workspaceRoot) {
    candidates.push(...(await discoverProjectInstructionFiles(workspaceRoot)));
  }

  const seen = new Set<string>();
  const files: InstructionFile[] = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const key = pathKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    const file = await readInstructionFile(resolved, onWarning);
    if (file) files.push(file);
  }
  return files;
}

/**
 * 从当前工作区向上找到最近的 `.git` 作为项目根，返回按“根 → 工作区”排序的文件。
 * 没有 `.git` 时只读取工作区自身，避免误读工作区之外任意父目录的指令。
 */
export async function discoverProjectInstructionFiles(
  workspaceRoot: string,
): Promise<readonly string[]> {
  const start = path.resolve(workspaceRoot);
  const stop = await findProjectRoot(start);
  const directories: string[] = [];
  let current = start;
  while (true) {
    directories.push(current);
    if (pathKey(current) === pathKey(stop)) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories.reverse().map((directory) => path.join(directory, INSTRUCTION_FILE_NAME));
}

async function findProjectRoot(start: string): Promise<string> {
  let current = start;
  while (true) {
    if (await pathExists(path.join(current, PROJECT_MARKER))) return current;
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

async function readInstructionFile(
  filePath: string,
  onWarning: ((message: string) => void) | undefined,
): Promise<InstructionFile | undefined> {
  let stat: Stats;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if (!isNotFound(error)) {
      onWarning?.(`读取 AGENTS.md 失败，已跳过：${filePath}（${describeError(error)}）`);
    }
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  if (stat.size > INSTRUCTION_FILE_MAX_BYTES) {
    onWarning?.(`AGENTS.md 超过 ${INSTRUCTION_FILE_MAX_BYTES} 字节，已跳过：${filePath}`);
    return undefined;
  }
  try {
    const content = await fs.readFile(filePath, "utf8");
    return { path: filePath, content: content.replace(/^\uFEFF/, "") };
  } catch (error) {
    onWarning?.(`读取 AGENTS.md 失败，已跳过：${filePath}（${describeError(error)}）`);
    return undefined;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Windows 路径大小写不敏感；去重时不能把同一文件当成两条指令。 */
function pathKey(target: string): string {
  return process.platform === "win32" ? target.toLowerCase() : target;
}

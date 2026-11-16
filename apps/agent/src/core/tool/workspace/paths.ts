/** 文件工具的路径解析与访问规则；工作区只是默认根目录，不是安全边界。 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { ToolExecutionError } from "../executor/result";
import { isNotFound } from "./errors";

const VCS_DIRS = new Set([".git", ".svn", ".hg", ".bzr", ".jj", ".sl"]);

export interface ToolTarget {
  readonly target: string;
  readonly kind: "file" | "directory";
  readonly searchRoot: string;
  readonly guestPath: string;
}

export interface ToolWriteTarget {
  readonly target: string;
  readonly exists: boolean;
}

export async function resolveToolFile(root: string | null, inputPath: string): Promise<string> {
  const target = await resolveToolTarget(root, inputPath);
  if (target.kind !== "file") throw new ToolExecutionError("invalid-input", "Agent 只能读取文件");
  return target.target;
}

export async function resolveToolWriteFile(
  root: string | null,
  inputPath: string,
): Promise<string> {
  const target = await resolveToolTarget(root, inputPath);
  if (target.kind !== "file") throw new ToolExecutionError("invalid-input", "Agent 只能编辑文件");
  return target.target;
}

/** 解析可创建或覆盖的写目标；父目录必须已存在，目标为目录时拒绝。 */
export async function resolveToolWriteTarget(
  root: string | null,
  inputPath: string,
): Promise<ToolWriteTarget> {
  const absoluteTarget = resolveInputPath(root, inputPath);
  assertAllowedPath(absoluteTarget);
  let realParent: string;
  try {
    realParent = await fs.realpath(path.dirname(absoluteTarget));
  } catch (error) {
    if (isNotFound(error)) {
      throw new ToolExecutionError("invalid-input", "写入目标的父目录不存在");
    }
    throw error;
  }
  assertAllowedPath(realParent);
  const parentStat = await fs.stat(realParent);
  if (!parentStat.isDirectory()) {
    throw new ToolExecutionError("invalid-input", "写入目标的父路径不是目录");
  }

  const candidate = path.join(realParent, path.basename(absoluteTarget));
  assertAllowedPath(candidate);
  try {
    const realTarget = await fs.realpath(candidate);
    assertAllowedPath(realTarget);
    const stat = await fs.stat(realTarget);
    if (!stat.isFile()) throw new ToolExecutionError("invalid-input", "Agent 只能写入文件");
    return { target: realTarget, exists: true };
  } catch (error) {
    if (isNotFound(error)) return { target: candidate, exists: false };
    throw error;
  }
}

export async function resolveToolTarget(
  root: string | null,
  inputPath: string,
): Promise<ToolTarget> {
  const absoluteTarget = resolveInputPath(root, inputPath);
  assertAllowedPath(absoluteTarget);
  const realTarget = await fs.realpath(absoluteTarget);
  assertAllowedPath(realTarget);
  const stat = await fs.stat(realTarget);
  if (!stat.isFile() && !stat.isDirectory())
    throw new ToolExecutionError("invalid-input", "Agent 只能访问文件或目录");
  const isFile = stat.isFile();
  return {
    target: realTarget,
    kind: isFile ? "file" : "directory",
    searchRoot: isFile ? path.dirname(realTarget) : realTarget,
    guestPath: isFile ? `./${path.basename(realTarget)}` : ".",
  };
}

function resolveInputPath(root: string | null, inputPath: string): string {
  if (!inputPath || inputPath.length > 1024)
    throw new ToolExecutionError("invalid-input", "文件路径无效");
  if (path.isAbsolute(inputPath)) return path.resolve(inputPath);
  if (/^[a-zA-Z]:/.test(inputPath))
    throw new ToolExecutionError("invalid-input", "路径不能是盘符相对形式");
  if (!root)
    throw new ToolExecutionError(
      "invalid-input",
      "使用相对路径前请先选择工作区目录，或提供绝对路径",
    );
  return path.resolve(root, inputPath);
}

function assertAllowedPath(target: string): void {
  for (const segment of path.resolve(target).split(path.sep)) {
    if (VCS_DIRS.has(segment))
      throw new ToolExecutionError("invalid-input", "Agent 不可访问版本库目录中的内容");
  }
}

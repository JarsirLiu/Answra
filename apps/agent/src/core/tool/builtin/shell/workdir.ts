/**
 * 解析 shell 的工作目录：工作区是默认根目录，不是访问边界。
 * 相对路径以工作区为基线，绝对路径直接使用；两者都经 realpath 后确认是目录。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { ToolExecutionError } from "../../executor/result";

export async function resolveShellWorkdir(
  workspaceRoot: string | null,
  input: string | undefined,
): Promise<string> {
  const requested = input?.trim();
  const target = resolveRequestedPath(workspaceRoot, requested);

  try {
    const realTarget = await fs.realpath(target);
    const stat = await fs.stat(realTarget);
    if (!stat.isDirectory())
      throw new ToolExecutionError("invalid-input", `工作目录不是目录：${input ?? target}`);
    return realTarget;
  } catch (error) {
    if (error instanceof ToolExecutionError) throw error;
    if (isNotFoundError(error))
      throw new ToolExecutionError("invalid-input", `工作目录不存在：${input ?? target}`);
    throw new ToolExecutionError(
      "handler-failed",
      error instanceof Error ? error.message : "无法解析工作目录",
    );
  }
}

function resolveRequestedPath(workspaceRoot: string | null, input: string | undefined): string {
  if (input === undefined || input === "") {
    if (!workspaceRoot)
      throw new ToolExecutionError(
        "invalid-input",
        "执行命令前请先选择工作区目录，或提供绝对 workdir",
      );
    return path.resolve(workspaceRoot);
  }

  if (path.isAbsolute(input)) return path.resolve(input);
  if (/^[a-zA-Z]:/.test(input))
    throw new ToolExecutionError("invalid-input", "workdir 不能是盘符相对形式");
  if (!workspaceRoot)
    throw new ToolExecutionError(
      "invalid-input",
      "使用相对 workdir 前请先选择工作区目录，或提供绝对 workdir",
    );
  return path.resolve(workspaceRoot, input);
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

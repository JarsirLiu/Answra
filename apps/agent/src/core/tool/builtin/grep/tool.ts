/** 使用 WASI ripgrep 做正则搜索，并投影为结构化结果。 */

import path from "node:path";
import { defineTool, type ToolContext, toolId } from "../../contracts";
import { ToolExecutionError } from "../../executor/result";
import { GREP_TOOL_NAME } from "../../names";
import { resolveToolTarget } from "../../workspace";
import {
  formatGrepOutput,
  GREP_DEFAULT_HEAD_LIMIT,
  GREP_MAX_OUTPUT_BYTES,
  type GrepOutput,
  parseGrepOutput,
} from "./output";
import { GREP_TOOL_DESCRIPTION } from "./prompt";
import { buildRipgrepArgs } from "./ripgrep/args";
import { createRipgrepError, runRipgrep } from "./ripgrep/runner";
import { GREP_INPUT_SCHEMA, type GrepInput, MAX_CONTEXT_LINES, MAX_HEAD_LIMIT } from "./schema";

const MAX_RAW_OUTPUT_BYTES = 16 * 1024 * 1024;

export const grepTool = defineTool<GrepInput, GrepOutput>({
  id: toolId("workspace.grep"),
  metadata: {
    name: GREP_TOOL_NAME,
    description: GREP_TOOL_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    sideEffectScope: "none",
    timeoutMs: 30_000,
    maxOutputBytes: MAX_RAW_OUTPUT_BYTES,
    resultBudget: {
      strategy: "truncate",
      maxModelChars: GREP_MAX_OUTPUT_BYTES,
      maxModelBytes: GREP_MAX_OUTPUT_BYTES,
    },
  },
  inputSchema: GREP_INPUT_SCHEMA,
  exposeOutput: true,
  handler: (input, context) => executeGrep(context, input),
  formatModelContent: formatGrepOutput,
});

export async function executeGrep(context: ToolContext, input: GrepInput): Promise<GrepOutput> {
  if (context.signal.aborted) throw new ToolExecutionError("aborted", "工具调用已取消");
  const root = context.workspaceRoot;

  let target: Awaited<ReturnType<typeof resolveToolTarget>>;
  try {
    target = await resolveToolTarget(root, input.path ?? ".");
  } catch (error) {
    if (error instanceof ToolExecutionError) throw error;
    throw new ToolExecutionError(
      "invalid-input",
      isNotFoundError(error) ? `路径不存在：${input.path ?? "."}` : errorMessage(error),
    );
  }

  const outputMode = input.output_mode ?? "files_with_matches";
  const contextLines = normalizeContext(input["-C"]);
  const beforeContext = normalizeContext(input["-B"] ?? contextLines);
  const afterContext = normalizeContext(input["-A"] ?? contextLines);
  const headLimit = normalizeHeadLimit(input.head_limit);
  const offset = normalizeOffset(input.offset);
  const args = buildRipgrepArgs(input, target.guestPath, { afterContext, beforeContext });
  const result = await runRipgrep(
    args,
    target.searchRoot,
    context.workerPaths?.grep,
    context.signal,
  );
  if (context.signal.aborted) throw new ToolExecutionError("aborted", "工具调用已取消");
  if (result.code === 2) throw createRipgrepError(result.stderr);
  if (result.code !== 0 && result.code !== 1) {
    throw new ToolExecutionError(
      "handler-failed",
      result.stderr.trim() || `ripgrep 退出码 ${result.code}`,
    );
  }

  return withDisplayPaths(
    parseGrepOutput(result.stdout, {
      afterContext,
      beforeContext,
      headLimit,
      lineNumbers: input["-n"] ?? true,
      offset,
      onlyMatching: input["-o"] ?? false,
      outputMode,
    }),
    target.searchRoot,
    root,
  );
}

function withDisplayPaths(
  output: GrepOutput,
  searchRoot: string,
  workspaceRoot: string | null,
): GrepOutput {
  const display = (filePath: string) => displayPath(searchRoot, workspaceRoot, filePath);
  switch (output.type) {
    case "files_with_matches":
      return { ...output, files: output.files.map(display) };
    case "count":
      return {
        ...output,
        counts: output.counts.map(({ path: filePath, count }) => ({
          path: display(filePath),
          count,
        })),
      };
    case "content":
      return {
        ...output,
        files: output.files.map(({ path: filePath, lines }) => ({
          path: display(filePath),
          lines,
        })),
      };
  }
}

function displayPath(searchRoot: string, workspaceRoot: string | null, filePath: string): string {
  const absolute = path.resolve(searchRoot, filePath);
  if (workspaceRoot) {
    const relative = path.relative(path.resolve(workspaceRoot), absolute);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative))
      return relative.split(path.sep).join("/");
  }
  return absolute.split(path.sep).join("/");
}

function normalizeContext(value: number | undefined): number {
  if (value === undefined) return 0;
  return Math.min(MAX_CONTEXT_LINES, Math.max(0, Math.trunc(value)));
}

function normalizeHeadLimit(value: number | undefined): number {
  if (value === undefined) return GREP_DEFAULT_HEAD_LIMIT;
  return Math.min(MAX_HEAD_LIMIT, Math.max(0, Math.trunc(value)));
}

function normalizeOffset(value: number | undefined): number {
  if (value === undefined) return 0;
  return Math.max(0, Math.trunc(value));
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Grep 执行失败";
}

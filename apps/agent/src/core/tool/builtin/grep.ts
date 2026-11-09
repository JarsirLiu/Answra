/** 使用 WASI ripgrep 做正则搜索，并投影为结构化结果。 */

import path from "node:path";
import { Worker } from "node:worker_threads";
import type { JSONSchema7 } from "ai";
import { ripgrep } from "ripgrep";
import { defineTool, type ToolContext, toolId } from "../contracts";
import { ToolExecutionError } from "../executor/result";
import {
  formatGrepOutput,
  GREP_DEFAULT_HEAD_LIMIT,
  GREP_MAX_LINE_CHARS,
  GREP_MAX_OUTPUT_BYTES,
  type GrepOutput,
  type GrepOutputMode,
  parseGrepOutput,
} from "./grepOutput";
import { resolveToolTarget } from "./workspace";

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: GrepOutputMode;
  "-A"?: number;
  "-B"?: number;
  "-C"?: number;
  "-n"?: boolean;
  "-i"?: boolean;
  "-o"?: boolean;
  head_limit?: number;
  offset?: number;
  multiline?: boolean;
}

const MAX_PATTERN_LENGTH = 512;
const MAX_CONTEXT_LINES = 50;
const MAX_HEAD_LIMIT = 10_000;
const MAX_RAW_OUTPUT_BYTES = 16 * 1024 * 1024;
const VCS_DIRS = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"] as const;
const TYPE_GLOBS: Readonly<Record<string, string>> = {
  c: "*.{c,h}",
  cpp: "*.{cc,cpp,cxx,h,hpp,hxx}",
  cs: "*.cs",
  css: "*.css",
  go: "*.go",
  html: "*.{html,htm}",
  java: "*.java",
  js: "*.{js,jsx,mjs,cjs}",
  json: "*.json",
  jsx: "*.jsx",
  kotlin: "*.{kt,kts}",
  md: "*.{md,mdx}",
  php: "*.php",
  py: "*.py",
  rb: "*.rb",
  rs: "*.rs",
  ruby: "*.rb",
  rust: "*.rs",
  scss: "*.scss",
  sh: "*.{sh,bash,zsh}",
  sql: "*.sql",
  swift: "*.swift",
  toml: "*.toml",
  ts: "*.{ts,tsx,mts,cts}",
  tsx: "*.tsx",
  xml: "*.xml",
  yaml: "*.{yaml,yml}",
  yml: "*.{yaml,yml}",
};

const GREP_TOOL_DESCRIPTION = [
  "Content search built on ripgrep.",
  "",
  '- Full regex syntax (e.g. "log.*Error", "function\\s+\\w+"). This is ripgrep, not grep; escape literal braces (`interface\\{\\}`).',
  '- Filter with `glob` (e.g. "**/*.tsx") or `type` (e.g. "js", "py", "rust").',
  '- `output_mode`: "content" (matching lines), "files_with_matches" (paths only, default), or "count".',
  "- `path` is a file or directory; defaults to the workspace root.",
  "- `multiline: true` for patterns that span lines.",
].join("\n");

const GREP_INPUT_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      minLength: 1,
      maxLength: MAX_PATTERN_LENGTH,
      description: "Ripgrep-compatible regular expression pattern to search for in file contents.",
    },
    path: {
      type: "string",
      minLength: 1,
      maxLength: 1024,
      description:
        "File or directory to search. Absolute and workspace-relative paths are accepted; defaults to the workspace root.",
    },
    glob: {
      type: "string",
      minLength: 1,
      maxLength: 1024,
      description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob.',
    },
    type: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      description: "File type to search (rg --type). Common types: js, py, rust, go, java.",
    },
    output_mode: {
      type: "string",
      enum: ["content", "files_with_matches", "count"],
      description:
        'Output mode: "content" shows matching lines, "files_with_matches" shows file paths, "count" shows match counts. Defaults to "files_with_matches".',
    },
    "-A": {
      type: "integer",
      minimum: 0,
      maximum: MAX_CONTEXT_LINES,
      description:
        'Number of lines to show after each match (rg -A). Requires output_mode: "content".',
    },
    "-B": {
      type: "integer",
      minimum: 0,
      maximum: MAX_CONTEXT_LINES,
      description:
        'Number of lines to show before each match (rg -B). Requires output_mode: "content".',
    },
    "-C": {
      type: "integer",
      minimum: 0,
      maximum: MAX_CONTEXT_LINES,
      description:
        'Number of lines to show before and after each match (rg -C). Requires output_mode: "content".',
    },
    "-n": {
      type: "boolean",
      description: "Show line numbers in output (rg -n). Defaults to true.",
    },
    "-i": { type: "boolean", description: "Case insensitive search (rg -i)." },
    "-o": {
      type: "boolean",
      description:
        'Print only the matched parts of each matching line (rg -o). Requires output_mode: "content".',
    },
    head_limit: {
      type: "integer",
      minimum: 0,
      maximum: MAX_HEAD_LIMIT,
      description: "Limit output to the first N entries. Defaults to 250. Pass 0 for unlimited.",
    },
    offset: {
      type: "integer",
      minimum: 0,
      description: "Skip the first N entries before applying head_limit. Defaults to 0.",
    },
    multiline: {
      type: "boolean",
      description:
        "Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.",
    },
  },
  required: ["pattern"],
  additionalProperties: false,
};

export const grepTool = defineTool<GrepInput, GrepOutput>({
  id: toolId("workspace.grep"),
  metadata: {
    name: "Grep",
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

function buildRipgrepArgs(
  input: GrepInput,
  guestPath: string,
  context: { afterContext: number; beforeContext: number },
): string[] {
  const args = [
    "--json",
    "--no-config",
    "--hidden",
    "--color",
    "never",
    "--max-columns",
    String(GREP_MAX_LINE_CHARS),
    ...VCS_DIRS.flatMap((directory) => ["--glob", `!**/${directory}/**`]),
  ];
  if (input.glob) args.push("--glob", input.glob);
  if (input.type) args.push("--glob", typeToGlob(input.type));
  if (input["-i"]) args.push("--ignore-case");
  if (input.multiline) args.push("--multiline", "--multiline-dotall");
  if (context.beforeContext > 0) args.push("--before-context", String(context.beforeContext));
  if (context.afterContext > 0) args.push("--after-context", String(context.afterContext));
  args.push("--regexp", input.pattern, "--", guestPath);
  return args;
}

async function runRipgrep(
  args: readonly string[],
  searchRoot: string,
  workerPath: string | undefined,
  signal: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (workerPath) return runRipgrepInWorker(args, searchRoot, workerPath, signal);
  try {
    return await ripgrep(args, {
      buffer: true,
      preopens: { ".": searchRoot },
    });
  } catch (error) {
    throw new ToolExecutionError("handler-failed", errorMessage(error));
  }
}

interface GrepWorkerResponse {
  readonly ok: boolean;
  readonly code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string;
}

function runRipgrepInWorker(
  args: readonly string[],
  searchRoot: string,
  workerPath: string,
  signal: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (signal.aborted) {
    return Promise.reject(new ToolExecutionError("aborted", "工具调用已取消"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(workerPath, { workerData: { args, searchRoot } });
    } catch (error) {
      reject(new ToolExecutionError("handler-failed", errorMessage(error)));
      return;
    }

    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate();
      action();
    };
    const onAbort = (): void => {
      settle(() => reject(new ToolExecutionError("aborted", "工具调用已取消")));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: GrepWorkerResponse) => {
      settle(() => {
        if (!message.ok) {
          reject(new ToolExecutionError("handler-failed", message.error ?? "Grep worker 失败"));
          return;
        }
        resolve({
          code: message.code ?? 2,
          stdout: message.stdout ?? "",
          stderr: message.stderr ?? "",
        });
      });
    });
    worker.once("error", (error) => {
      settle(() => reject(new ToolExecutionError("handler-failed", errorMessage(error))));
    });
    worker.once("exit", (code) => {
      settle(() => reject(new ToolExecutionError("handler-failed", `Grep worker 退出码 ${code}`)));
    });
  });
}

function typeToGlob(type: string): string {
  const normalized = type.trim().replace(/^\./, "").toLowerCase();
  if (!/^[a-z0-9_+.-]+$/.test(normalized))
    throw new ToolExecutionError("invalid-input", "type 参数无效");
  return TYPE_GLOBS[normalized] ?? `*.${normalized}`;
}

function createRipgrepError(stderr: string): ToolExecutionError {
  const detail = stderr.trim() || "ripgrep 执行失败";
  if (/regex parse error|error parsing glob|unrecognized flag/i.test(detail)) {
    return new ToolExecutionError("invalid-input", detail);
  }
  return new ToolExecutionError("handler-failed", detail);
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

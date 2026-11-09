/** 读取有大小/token 上限、带行号的 UTF-8/UTF-16 纯文本；相对路径以当前工作区为基线。 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { JSONSchema7 } from "ai";
import { defineTool, type ReadFileStateEntry, type ToolContext, toolId } from "../contracts";
import { ToolExecutionError } from "../executor/result";
import {
  createReadTextOutput,
  formatReadOutput,
  type ReadOutput,
  ReadOutputTooLargeError,
} from "./readOutput";
import {
  assertNotAborted,
  READ_FILE_MAX_BYTES,
  READ_SCAN_MAX_BYTES,
  readToolTextFile,
  statToolFile,
  type ToolFileStat,
} from "./workspace";

interface ReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

const READ_TOOL_DESCRIPTION = [
  "Reads a text file from the local filesystem.",
  "",
  "- `file_path` should be an absolute path; a path relative to the workspace root is also accepted.",
  "- Reads the whole file by default; long files return a partial view with continuation information.",
  "- Use `offset` and `limit` to read a specific line range.",
  "- Results use cat -n format, with line numbers starting at 1.",
  "- Reading a directory, a missing file, or a non-text file returns an error instead of content.",
  "- Do not re-read a file you just edited to verify.",
].join("\n");

const READ_INPUT_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    file_path: {
      type: "string",
      minLength: 1,
      maxLength: 1024,
      description:
        "The path to the file to read. Absolute paths are preferred; workspace-relative paths are also accepted.",
    },
    offset: {
      type: "integer",
      minimum: 1,
      description: "The 1-based line number to start reading from.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      description: "The number of lines to read.",
    },
  },
  required: ["file_path"],
  additionalProperties: false,
};

export const readTool = defineTool<ReadInput, ReadOutput>({
  id: toolId("workspace.read"),
  metadata: {
    name: "Read",
    description: READ_TOOL_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    sideEffectScope: "none",
    timeoutMs: 30_000,
    maxOutputBytes: READ_FILE_MAX_BYTES,
    resultBudget: { strategy: "truncate", maxModelChars: READ_FILE_MAX_BYTES },
  },
  inputSchema: READ_INPUT_SCHEMA,
  handler: (input, context) => executeRead(context, input),
  formatModelContent: formatReadOutput,
});

export async function executeRead(context: ToolContext, input: ReadInput): Promise<ReadOutput> {
  const root = context.workspaceRoot;
  const offset = normalizeOffset(input.offset);
  const limit = normalizeLimit(input.limit);

  try {
    assertNotAborted(context.signal);
    const stat = await statToolFile(root, input.file_path);
    const key = createReadFileStateKey(stat.target, offset, limit);
    const cached = context.readFileState?.get(key);
    if (cached && isCachedReadFresh(cached, stat)) {
      return { type: "file_unchanged", filePath: stat.target };
    }

    const maxBytes = limit === undefined ? READ_FILE_MAX_BYTES : READ_SCAN_MAX_BYTES;
    if (stat.sizeBytes > maxBytes) {
      throw new ToolExecutionError(
        "output-too-large",
        `文件 ${stat.sizeBytes} 字节，超过单次读取上限 ${maxBytes} 字节`,
      );
    }

    const read = await readToolTextFile(stat.target, maxBytes);
    assertNotAborted(context.signal);
    const output = createReadTextOutput({
      bytesRead: read.bytesRead,
      filePath: stat.target,
      limit,
      offset,
      sizeBytes: stat.sizeBytes,
      text: read.text,
    });
    context.readFileState?.set(key, {
      limit,
      mtimeMs: Math.trunc(stat.mtimeMs),
      offset,
      partialView: output.truncatedByTokenCap === true,
      path: stat.target,
      sizeBytes: stat.sizeBytes,
    });
    return output;
  } catch (error) {
    if (error instanceof ToolExecutionError) throw error;
    if (context.signal.aborted) throw new ToolExecutionError("aborted", "工具调用已取消");
    if (error instanceof ReadOutputTooLargeError) {
      throw new ToolExecutionError("output-too-large", error.message);
    }
    if (isFileNotFoundError(error)) {
      throw new ToolExecutionError(
        "invalid-input",
        await createMissingReadFileMessage(root, input.file_path),
      );
    }
    if (error instanceof Error) throw new ToolExecutionError("handler-failed", error.message);
    throw error;
  }
}

function normalizeOffset(offset: number | undefined): number {
  return offset === undefined ? 1 : Math.max(1, Math.trunc(offset));
}

function normalizeLimit(limit: number | undefined): number | undefined {
  return limit === undefined ? undefined : Math.max(1, Math.trunc(limit));
}

function createReadFileStateKey(
  filePath: string,
  offset: number,
  limit: number | undefined,
): string {
  return [
    readStatePathKey(filePath),
    String(offset),
    limit === undefined ? "" : String(limit),
  ].join("\0");
}

function readStatePathKey(filePath: string): string {
  const normalized = path.resolve(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isCachedReadFresh(entry: ReadFileStateEntry, stat: ToolFileStat): boolean {
  return (
    !entry.partialView &&
    entry.mtimeMs === Math.trunc(stat.mtimeMs) &&
    entry.sizeBytes === stat.sizeBytes
  );
}

async function createMissingReadFileMessage(
  root: string | null,
  inputPath: string,
): Promise<string> {
  const target = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(root ?? process.cwd(), inputPath);
  const suggestion = await findSimilarFilename(target);
  const displaySuggestion = suggestion
    ? displayPath(root, path.join(path.dirname(target), suggestion))
    : undefined;
  const rootDescription = root
    ? `当前工作区根目录是 ${root}。`
    : "尚未选择工作区目录，已按绝对路径查找。";
  return `文件不存在。${rootDescription}${
    displaySuggestion ? ` 是否想找 ${displaySuggestion}？` : ""
  }`;
}

function displayPath(root: string | null, target: string): string {
  if (root) {
    const relative = path.relative(path.resolve(root), target);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative))
      return relative.split(path.sep).join("/");
  }
  return target.split(path.sep).join("/");
}

async function findSimilarFilename(target: string): Promise<string | undefined> {
  const targetName = path.basename(target);
  const targetStem = path.basename(target, path.extname(target));
  let entries: string[];
  try {
    entries = (await fs.readdir(path.dirname(target), { withFileTypes: true }))
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => name !== targetName && !name.startsWith("."))
      .sort();
  } catch {
    return undefined;
  }

  const sameStem = entries.find((name) => path.basename(name, path.extname(name)) === targetStem);
  if (sameStem) return sameStem;
  return entries.find((name) => levenshteinDistance(name, targetName) <= 3);
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const insertion = (current[rightIndex - 1] ?? 0) + 1;
      const deletion = (previous[rightIndex] ?? 0) + 1;
      const substitution = (previous[rightIndex - 1] ?? 0) + cost;
      current[rightIndex] = Math.min(insertion, deletion, substitution);
    }
    for (let index = 0; index < previous.length; index += 1) {
      previous[index] = current[index] ?? 0;
    }
  }

  return previous[right.length] ?? 0;
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

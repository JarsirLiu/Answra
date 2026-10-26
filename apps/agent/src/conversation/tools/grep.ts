/** Grep searches bounded plain-text workspace files for a literal string. */

import { promises as fs } from "node:fs";
import { jsonSchema, tool } from "ai";
import type { ConversationToolContext } from "./types";
import {
  assertNotAborted,
  collectWorkspaceTextFiles,
  relativeWorkspacePath,
  requireWorkspaceRoot,
  TEXT_FILE_MAX_BYTES,
  truncateToolOutput,
} from "./workspace";

interface GrepInput {
  pattern: string;
  path?: string;
  ignore_case?: boolean;
  context?: number;
  max_results?: number;
}

const MAX_PATTERN_LENGTH = 512;
const DEFAULT_MAX_RESULTS = 100;
const MAX_GREP_FILES = 500;
const MAX_GREP_BYTES = 16 * 1024 * 1024;

export const grepDefinition = {
  id: "conversation.grep",
  name: "Grep",
  description: "搜索工作区纯文本文件中的字面文本。可指定相对路径、忽略大小写和匹配行上下文。",
  inputSchema: jsonSchema<GrepInput>({
    type: "object",
    properties: {
      pattern: { type: "string", minLength: 1, maxLength: MAX_PATTERN_LENGTH },
      path: { type: "string", minLength: 1, maxLength: 1024 },
      ignore_case: { type: "boolean" },
      context: { type: "integer", minimum: 0, maximum: 5 },
      max_results: { type: "integer", minimum: 1, maximum: DEFAULT_MAX_RESULTS },
    },
    required: ["pattern"],
    additionalProperties: false,
  }),
  create(context: ConversationToolContext) {
    return tool({
      description: this.description,
      inputSchema: this.inputSchema,
      execute: (input) => executeGrep(context, input),
    });
  },
} as const;

export async function executeGrep(
  context: ConversationToolContext,
  {
    pattern,
    path: searchPath,
    ignore_case = false,
    context: contextLines = 0,
    max_results = DEFAULT_MAX_RESULTS,
  }: GrepInput,
): Promise<string> {
  assertNotAborted(context.signal);
  const root = requireWorkspaceRoot(context.workspaceRoot);
  const canonicalRoot = await fs.realpath(root);
  const files = await collectWorkspaceTextFiles(canonicalRoot, context.signal);
  const needle = ignore_case ? pattern.toLocaleLowerCase() : pattern;
  const results: string[] = [];
  let scannedBytes = 0;
  const requested = searchPath && searchPath !== "." ? searchPath.replace(/[\\/]+$/, "") : "";
  for (const file of files.slice(0, MAX_GREP_FILES)) {
    assertNotAborted(context.signal);
    const relativePath = relativeWorkspacePath(canonicalRoot, file);
    if (requested && relativePath !== requested && !relativePath.startsWith(`${requested}/`))
      continue;
    const stat = await fs.stat(file);
    if (stat.size > TEXT_FILE_MAX_BYTES) continue;
    scannedBytes += stat.size;
    if (scannedBytes > MAX_GREP_BYTES) break;
    if (results.length >= max_results) break;
    const lines = (await fs.readFile(file, "utf8")).split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const candidate = ignore_case ? line.toLocaleLowerCase() : line;
      if (!candidate.includes(needle)) continue;
      const start = Math.max(0, index - contextLines);
      const end = Math.min(lines.length, index + contextLines + 1);
      for (let lineIndex = start; lineIndex < end; lineIndex += 1) {
        const row = `${relativePath}:${lineIndex + 1}:${lines[lineIndex] ?? ""}`;
        if (!results.includes(row)) results.push(row);
      }
      if (results.length >= max_results)
        return truncateToolOutput(`${results.join("\n")}\n[结果达到上限]`);
    }
  }
  return truncateToolOutput(results.length ? results.join("\n") : "未找到匹配内容");
}

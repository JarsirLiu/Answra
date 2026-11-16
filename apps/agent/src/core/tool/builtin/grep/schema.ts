/** Grep 的模型输入、schema 与共享边界；不执行搜索。 */

import type { JSONSchema7 } from "ai";
import type { GrepOutputMode } from "./output";

export interface GrepInput {
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

export const MAX_PATTERN_LENGTH = 512;
export const MAX_CONTEXT_LINES = 50;
export const MAX_HEAD_LIMIT = 10_000;

export const GREP_INPUT_SCHEMA: JSONSchema7 = {
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

/** ripgrep 参数构造；把 GrepInput 投影为固定 CLI 契约。 */

import { ToolExecutionError } from "../../../executor/result";
import { GREP_MAX_LINE_CHARS } from "../output";
import type { GrepInput } from "../schema";

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

export function buildRipgrepArgs(
  input: GrepInput,
  guestPath: string,
  context: { readonly afterContext: number; readonly beforeContext: number },
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

function typeToGlob(type: string): string {
  const normalized = type.trim().replace(/^\./, "").toLowerCase();
  if (!/^[a-z0-9_+.-]+$/.test(normalized))
    throw new ToolExecutionError("invalid-input", "type 参数无效");
  return TYPE_GLOBS[normalized] ?? `*.${normalized}`;
}

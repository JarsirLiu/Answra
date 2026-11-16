/** Grep 的模型可见说明；只描述能力，不承载执行参数。 */

export const GREP_TOOL_DESCRIPTION = [
  "Content search built on ripgrep.",
  "",
  '- Full regex syntax (e.g. "log.*Error", "function\\s+\\w+"). This is ripgrep, not grep; escape literal braces (`interface\\{\\}`).',
  '- Filter with `glob` (e.g. "**/*.tsx") or `type` (e.g. "js", "py", "rust").',
  '- `output_mode`: "content" (matching lines), "files_with_matches" (paths only, default), or "count".',
  "- `path` is a file or directory; defaults to the workspace root.",
  "- `multiline: true` for patterns that span lines.",
].join("\n");

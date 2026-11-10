/** Edit 的纯文本匹配与替换：精确优先，最多再剥离 Read 行号前缀；不做模糊猜测。 */

export type EditMatchFailureReason = "not-found" | "ambiguous";

export type EditMatchResult =
  | { readonly type: "matched"; readonly text: string; readonly replacements: number }
  | { readonly type: "failed"; readonly reason: EditMatchFailureReason; readonly matches: number };

const READ_LINE_PREFIX = /^\d+(?:\t|: )/;

export function replaceEditText(input: {
  readonly text: string;
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll: boolean;
}): EditMatchResult {
  const text = normalizeLineEndings(input.text);
  const newString = normalizeLineEndings(input.newString);
  const oldString = normalizeLineEndings(input.oldString);
  if (oldString.length === 0) return { type: "failed", reason: "not-found", matches: 0 };

  let match = countMatches(text, oldString);
  let needle = oldString;
  if (match === 0) {
    const stripped = stripReadLinePrefixes(oldString);
    if (stripped !== undefined && stripped.length > 0) {
      needle = stripped;
      match = countMatches(text, needle);
    }
  }

  if (match === 0) return { type: "failed", reason: "not-found", matches: 0 };
  if (!input.replaceAll && match > 1)
    return { type: "failed", reason: "ambiguous", matches: match };

  const parts = text.split(needle);
  return { type: "matched", text: parts.join(newString), replacements: match };
}

function countMatches(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function stripReadLinePrefixes(value: string): string | undefined {
  const lines = value.split("\n");
  if (!lines.every((line) => READ_LINE_PREFIX.test(line))) return undefined;
  return lines.map((line) => line.replace(READ_LINE_PREFIX, "")).join("\n");
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

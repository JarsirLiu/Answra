/**
 * SKILL.md 的 YAML frontmatter 解析：只支持 `key: value` 扁平字符串，
 * 不支持嵌套、列表与多行标量——skill 只需 name/description，多余语法一律视为非法。
 */

export interface SkillFrontmatter {
  readonly name: string | undefined;
  readonly description: string | undefined;
}

export interface ParsedSkillDocument {
  readonly frontmatter: SkillFrontmatter;
  readonly content: string;
}

const DELIMITER = "---";
const FRONTMATTER_KEY_PATTERN = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/;

/**
 * 解析失败返回 `undefined`：没有 frontmatter、分隔符不闭合、行不符合 `key: value`
 * 都算失败。调用方据此跳过该文件，不猜测结构。
 */
export function parseSkillDocument(text: string): ParsedSkillDocument | undefined {
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  if (lines[0]?.trim() !== DELIMITER) return undefined;

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === DELIMITER);
  if (closingIndex < 0) return undefined;

  const frontmatter = parseFrontmatterLines(lines.slice(1, closingIndex));
  if (!frontmatter) return undefined;

  return {
    frontmatter,
    content: lines
      .slice(closingIndex + 1)
      .join("\n")
      .trim(),
  };
}

function parseFrontmatterLines(lines: readonly string[]): SkillFrontmatter | undefined {
  let name: string | undefined;
  let description: string | undefined;

  for (const line of lines) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const match = FRONTMATTER_KEY_PATTERN.exec(line);
    if (!match) return undefined;

    const key = match[1];
    const value = unquote(match[2] ?? "");
    if (key === "name") name = value;
    else if (key === "description") description = value;
    // 其余键（如 slash）当前不消费，但允许存在以保持前向兼容。
  }

  return { name: emptyToUndefined(name), description: emptyToUndefined(description) };
}

/** 去掉成对引号；YAML 引号内的转义不在本实现范围内。 */
function unquote(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.length >= 2 && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

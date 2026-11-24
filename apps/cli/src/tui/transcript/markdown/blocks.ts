/** 终端 Markdown 分块解析：代码围栏与 GFM 表格优先，其余按行分类；不依赖 Ink。 */
import { type MarkdownTable, parseTableAt } from "./table";

export type LineVariant = "text" | "heading" | "list" | "quote" | "rule";

export interface CodeLine {
  id: string;
  text: string;
}

export type MarkdownBlock =
  | { id: string; kind: "line"; text: string; variant: LineVariant }
  | { id: string; kind: "code"; language?: string; lines: CodeLine[] }
  | { id: string; kind: "table"; table: MarkdownTable };

export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const source = text.split("\n");
  const blocks: MarkdownBlock[] = [];
  let nextId = 0;
  let index = 0;

  while (index < source.length) {
    const raw = source[index] ?? "";
    const fence = raw.match(/^\s*```(.*)$/);
    if (fence !== null) {
      const language = fence[1]?.trim();
      const lines: CodeLine[] = [];
      index += 1;
      while (index < source.length && !/^\s*```\s*$/.test(source[index] ?? "")) {
        lines.push({ id: `code-${nextId}-${lines.length}`, text: source[index] ?? "" });
        index += 1;
      }
      // 跳过闭合围栏；未闭合时 index 已越过末尾，直接收口为代码块。
      index += 1;
      blocks.push({
        id: `block-${nextId++}`,
        kind: "code",
        ...(language === undefined || language === "" ? {} : { language }),
        lines,
      });
      continue;
    }

    const table = parseTableAt(source, index);
    if (table !== undefined) {
      blocks.push({ id: `block-${nextId++}`, kind: "table", table: table.table });
      index = table.nextIndex;
      continue;
    }

    blocks.push(classifyLine(raw, `block-${nextId++}`));
    index += 1;
  }

  return blocks;
}

function classifyLine(raw: string, id: string): MarkdownBlock {
  if (/^\s*(---+|\*\*\*+)\s*$/.test(raw))
    return { id, kind: "line", text: "─".repeat(40), variant: "rule" };
  const heading = raw.match(/^\s{0,3}#{1,6}\s+(.*)$/);
  if (heading !== null) return { id, kind: "line", text: heading[1] ?? "", variant: "heading" };
  const quote = raw.match(/^\s*>\s?(.*)$/);
  if (quote !== null) return { id, kind: "line", text: `│ ${quote[1] ?? ""}`, variant: "quote" };
  const list = raw.match(/^(\s*)[-*]\s+(.*)$/);
  if (list !== null)
    return {
      id,
      kind: "line",
      text: `${list[1] ?? ""}• ${list[2] ?? ""}`,
      variant: "list",
    };
  return { id, kind: "line", text: raw, variant: "text" };
}

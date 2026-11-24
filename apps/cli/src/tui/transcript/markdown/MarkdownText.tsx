/** 终端 Markdown 投影：标题、列表、引用、行内样式、围栏代码与 GFM 表格；不做终端重排。 */
import { Box, useWindowSize } from "ink";
import { memo, type ReactNode, useContext, useMemo } from "react";
import { TUI_THEME } from "../../chrome/theme";
import { SelectableText } from "../SelectableText";
import { type LineVariant, type MarkdownBlock, parseMarkdownBlocks } from "./blocks";
import { MarkdownColumnsContext } from "./columns";
import { renderInline } from "./inline";
import { layoutMarkdownTable, TABLE_MIN_WIDTH, TABLE_SAFETY_MARGIN } from "./table";

export const MarkdownText = memo(function MarkdownText({
  text,
  dimColor = false,
}: {
  text: string;
  dimColor?: boolean;
}) {
  const columns = useContext(MarkdownColumnsContext);
  if (columns === undefined) return <WindowedMarkdownText dimColor={dimColor} text={text} />;
  return <MarkdownBody columns={columns} dimColor={dimColor} text={text} />;
});

/** 没有 transcript 列宽时退回自身订阅；正常情况下由视口统一注入。 */
function WindowedMarkdownText({ text, dimColor }: { text: string; dimColor: boolean }) {
  const { columns } = useWindowSize();
  return <MarkdownBody columns={columns} dimColor={dimColor} text={text} />;
}

const MarkdownBody = memo(function MarkdownBody({
  text,
  dimColor,
  columns,
}: {
  text: string;
  dimColor: boolean;
  columns: number;
}) {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);
  const tableWidth = Math.max(TABLE_MIN_WIDTH, columns - TABLE_SAFETY_MARGIN);
  return (
    <Box flexDirection="column">
      {blocks.map((block) => renderBlock(block, dimColor, tableWidth))}
    </Box>
  );
});

function renderBlock(block: MarkdownBlock, dimColor: boolean, tableWidth: number): ReactNode {
  switch (block.kind) {
    case "code":
      return <CodeBlock block={block} dimColor={dimColor} key={block.id} />;
    case "table":
      return <TableBlock block={block} dimColor={dimColor} key={block.id} width={tableWidth} />;
    case "line":
      return (
        <SelectableText {...variantProps(block.variant, dimColor)} key={block.id}>
          {block.text.length === 0 ? " " : renderInline(block.text, dimColor)}
        </SelectableText>
      );
  }
}

function CodeBlock({
  block,
  dimColor,
}: {
  block: Extract<MarkdownBlock, { kind: "code" }>;
  dimColor: boolean;
}) {
  return (
    <Box flexDirection="column" marginY={1} paddingLeft={1}>
      {block.language === undefined || block.language.length === 0 ? null : (
        <SelectableText dimColor>{block.language}</SelectableText>
      )}
      {block.lines.map((line) => (
        <SelectableText color={TUI_THEME.codeBlock} dimColor={dimColor} key={line.id}>
          {line.text.length === 0 ? " " : line.text}
        </SelectableText>
      ))}
    </Box>
  );
}

function TableBlock({
  block,
  dimColor,
  width,
}: {
  block: Extract<MarkdownBlock, { kind: "table" }>;
  dimColor: boolean;
  width: number;
}) {
  const lines = useMemo(() => layoutMarkdownTable(block.table, width), [block.table, width]);
  const keyedLines = useMemo(() => {
    const seen = new Map<string, number>();
    return lines.map((text) => {
      const occurrence = seen.get(text) ?? 0;
      seen.set(text, occurrence + 1);
      return { id: `${block.id}:${text}:${occurrence}`, text };
    });
  }, [lines, block.id]);
  return (
    <Box flexDirection="column" marginY={1}>
      {keyedLines.map((line) => (
        <SelectableText color={TUI_THEME.text} dimColor={dimColor} key={line.id}>
          {line.text.length === 0 ? " " : line.text}
        </SelectableText>
      ))}
    </Box>
  );
}

function variantProps(variant: LineVariant, dimColor: boolean) {
  switch (variant) {
    case "heading":
      return { bold: true, color: TUI_THEME.text, dimColor };
    case "quote":
      return { dimColor: true };
    case "rule":
      return { dimColor: true };
    default:
      return { dimColor };
  }
}

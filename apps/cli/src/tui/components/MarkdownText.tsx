/** 终端 Markdown 投影：标题、列表、引用、内联代码/粗体与围栏代码；不做终端重排。 */
import { Box, Text } from "ink";
import { memo, type ReactNode, useMemo } from "react";
import { TUI_THEME } from "../theme";

type LineVariant = "text" | "heading" | "list" | "quote" | "rule";

interface CodeLine {
  id: string;
  text: string;
}

type Block =
  | { id: string; kind: "line"; text: string; variant: LineVariant }
  | { id: string; kind: "code"; language?: string; lines: CodeLine[] };

export const MarkdownText = memo(function MarkdownText({
  text,
  dimColor = false,
}: {
  text: string;
  dimColor?: boolean;
}) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <Box flexDirection="column">
      {blocks.map((block) =>
        block.kind === "code" ? (
          <CodeBlock block={block} dimColor={dimColor} key={block.id} />
        ) : (
          <Text {...variantProps(block.variant, dimColor)} key={block.id}>
            {block.text.length === 0 ? " " : inline(block.text, dimColor)}
          </Text>
        ),
      )}
    </Box>
  );
});

function CodeBlock({
  block,
  dimColor,
}: {
  block: Extract<Block, { kind: "code" }>;
  dimColor: boolean;
}) {
  return (
    <Box flexDirection="column" marginY={1} paddingLeft={1}>
      {block.language === undefined || block.language.length === 0 ? null : (
        <Text dimColor>{block.language}</Text>
      )}
      {block.lines.map((line) => (
        <Text color={TUI_THEME.codeBlock} dimColor={dimColor} key={line.id}>
          {line.text.length === 0 ? " " : line.text}
        </Text>
      ))}
    </Box>
  );
}

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let code: Extract<Block, { kind: "code" }> | undefined;
  let nextId = 0;

  for (const raw of text.split("\n")) {
    const fence = raw.match(/^\s*```(.*)$/);
    if (fence !== null) {
      if (code === undefined) {
        const language = fence[1]?.trim();
        code = {
          id: `block-${nextId++}`,
          kind: "code",
          language: language === "" ? undefined : language,
          lines: [],
        };
      } else {
        blocks.push(code);
        code = undefined;
      }
      continue;
    }
    if (code !== undefined) {
      code.lines.push({ id: `${code.id}-${code.lines.length}`, text: raw });
      continue;
    }
    blocks.push(classifyLine(raw, `block-${nextId++}`));
  }
  if (code !== undefined) blocks.push(code);
  return blocks;
}

function classifyLine(raw: string, id: string): Block {
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

function inline(text: string, dimColor: boolean): ReactNode[] {
  const nodes: ReactNode[] = [];
  const token = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let cursor = 0;
  for (const match of text.matchAll(token)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    const value = match[0];
    if (value.startsWith("**")) {
      nodes.push(
        <Text bold dimColor={dimColor} key={index}>
          {value.slice(2, -2)}
        </Text>,
      );
    } else if (value.startsWith("`")) {
      nodes.push(
        <Text
          backgroundColor={TUI_THEME.userMessageBackground}
          color={TUI_THEME.code}
          dimColor={dimColor}
          key={index}
        >
          {value.slice(1, -1)}
        </Text>,
      );
    } else {
      nodes.push(
        <Text color={TUI_THEME.suggestion} dimColor={dimColor} key={index}>
          {value.replace(/^\[([^\]]+)\].*$/, "$1")}
        </Text>,
      );
    }
    cursor = index + value.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

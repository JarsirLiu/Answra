/** 终端输入投影：按显示宽度换行，保持宽字符/emoji 光标对齐，并限制可视行数。 */
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { TUI_THEME } from "../chrome/theme";
import { type ImageReference, imageReferences } from "./imageReferences";
import { layoutInput } from "./inputLayout";

export function TextInput({
  value,
  cursor,
  placeholder,
  maxVisibleLines,
  columns,
  secret = false,
  secretMask,
  selectionStart,
  selectionEnd,
  highlightImageReferences = false,
}: {
  value: string;
  cursor: number;
  placeholder: string;
  maxVisibleLines: number;
  columns: number;
  secret?: boolean;
  secretMask?: (value: string) => string;
  selectionStart?: number;
  selectionEnd?: number;
  highlightImageReferences?: boolean;
}) {
  const displayValue = secret ? (secretMask?.(value) ?? "•".repeat(value.length)) : value;
  const references =
    highlightImageReferences && !secret ? imageReferences(displayValue) : undefined;
  const layout =
    displayValue.length === 0
      ? undefined
      : layoutInput(displayValue, cursor, columns, maxVisibleLines);

  if (layout === undefined) {
    const hint = layoutInput(placeholder, 0, columns, 1)
      .lines[0]?.tokens.map((token) => token.text)
      .join("");
    return (
      <Box flexDirection="column" width="100%">
        <Text>
          <Text inverse> </Text>
          <Text dimColor>{hint ?? ""}</Text>
        </Text>
      </Box>
    );
  }

  const selection =
    !secret && selectionStart !== undefined && selectionEnd !== undefined
      ? {
          start: Math.min(selectionStart, selectionEnd),
          end: Math.max(selectionStart, selectionEnd),
        }
      : undefined;
  const hasSelection = selection !== undefined && selection.start < selection.end;
  const endLine = layout.startLine + layout.visibleLineCount;
  return (
    <Box flexDirection="column" width="100%">
      {layout.hiddenAbove > 0 ? <Text dimColor>…</Text> : null}
      {layout.lines.slice(layout.startLine, endLine).map((line, index) => {
        const lineIndex = layout.startLine + index;
        return (
          <Text key={lineIndex}>
            {renderLine(
              line.tokens,
              hasSelection
                ? undefined
                : lineIndex === layout.cursorLine
                  ? layout.cursorColumn
                  : undefined,
              hasSelection ? selection : undefined,
              references,
            )}
          </Text>
        );
      })}
      {layout.hiddenBelow > 0 ? <Text dimColor>…</Text> : null}
    </Box>
  );
}

function renderLine(
  tokens: readonly { text: string; width: number; offset: number }[],
  cursorColumn: number | undefined,
  selection: { readonly start: number; readonly end: number } | undefined,
  references: readonly ImageReference[] | undefined,
): ReactNode[] {
  if (tokens.length === 0) {
    if (cursorColumn === undefined) return [" "];
    return [
      <Text inverse key="cursor-end">
        {" "}
      </Text>,
    ];
  }
  const nodes: ReactNode[] = [];
  let column = 0;
  let cursorRendered = cursorColumn === undefined;
  for (const [index, token] of tokens.entries()) {
    const selected =
      selection !== undefined && token.offset >= selection.start && token.offset < selection.end;
    const isCursor =
      cursorColumn !== undefined && !cursorRendered && cursorColumn < column + token.width;
    if (isCursor) {
      nodes.push(
        <Text inverse key={`cursor-${index}`}>
          {token.text}
        </Text>,
      );
      cursorRendered = true;
    } else if (selected) {
      nodes.push(
        <Text inverse key={`selected-${token.offset}`}>
          {token.text}
        </Text>,
      );
    } else if (references !== undefined && isInReference(references, token.offset)) {
      nodes.push(
        <Text color={TUI_THEME.code} key={`reference-${token.offset}`}>
          {token.text}
        </Text>,
      );
    } else {
      nodes.push(token.text);
    }
    column += token.width;
  }
  if (!cursorRendered) {
    nodes.push(
      <Text inverse key="cursor-end">
        {" "}
      </Text>,
    );
  }
  return nodes;
}

function isInReference(references: readonly ImageReference[], offset: number): boolean {
  return references.some((reference) => offset >= reference.start && offset < reference.end);
}

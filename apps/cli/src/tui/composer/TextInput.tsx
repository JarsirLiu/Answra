/** 终端输入投影：按显示宽度换行，保持宽字符/emoji 光标对齐，并限制可视行数。 */
import { Box, type DOMElement, measureElement, Text, useBoxMetrics, useCursor } from "ink";
import { type ReactNode, useRef } from "react";
import { cursorCellAt, layoutInput } from "./inputLayout";

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
}) {
  const inputRef = useRef<DOMElement | null>(null);
  const measured = useBoxMetrics(inputRef);
  const { setCursorPosition } = useCursor();
  const displayValue = secret ? (secretMask?.(value) ?? "•".repeat(value.length)) : value;
  const layout =
    displayValue.length === 0
      ? undefined
      : layoutInput(displayValue, cursor, columns, maxVisibleLines);
  const origin =
    measured.hasMeasured && inputRef.current !== null
      ? measureElement(inputRef.current)
      : undefined;
  setCursorPosition(
    origin === undefined || origin.width === 0
      ? undefined
      : layout === undefined
        ? { x: origin.x, y: origin.y }
        : cursorCellAt(layout, origin),
  );

  if (layout === undefined) {
    const hint = layoutInput(placeholder, 0, columns, 1)
      .lines[0]?.tokens.map((token) => token.text)
      .join("");
    return (
      <Box flexDirection="column" ref={inputRef} width="100%">
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
    <Box flexDirection="column" ref={inputRef} width="100%">
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
): ReactNode[] {
  if (selection !== undefined) {
    if (tokens.length === 0) return [" "];
    return tokens.map((token) =>
      token.offset >= selection.start && token.offset < selection.end ? (
        <Text inverse key={`selected-${token.offset}`}>
          {token.text}
        </Text>
      ) : (
        token.text
      ),
    );
  }
  if (cursorColumn === undefined) {
    return tokens.length === 0 ? [" "] : tokens.map((token) => token.text);
  }
  const nodes: ReactNode[] = [];
  let column = 0;
  let cursorRendered = false;
  for (const [index, token] of tokens.entries()) {
    if (!cursorRendered && cursorColumn < column + token.width) {
      nodes.push(
        <Text inverse key={`cursor-${index}`}>
          {token.text}
        </Text>,
      );
      cursorRendered = true;
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

/** 终端输入投影：按显示宽度换行，保持宽字符/emoji 光标对齐，并限制可视行数。 */
import { Box, Text, useWindowSize } from "ink";
import type { ReactNode } from "react";
import { layoutInput } from "./inputLayout";

export function TextInput({
  value,
  cursor,
  placeholder,
  maxVisibleLines,
}: {
  value: string;
  cursor: number;
  placeholder: string;
  maxVisibleLines: number;
}) {
  const { columns: windowColumns } = useWindowSize();
  const columns = Math.max(1, windowColumns - 4);

  if (value.length === 0) {
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

  const layout = layoutInput(value, cursor, columns, maxVisibleLines);
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
              lineIndex === layout.cursorLine ? layout.cursorColumn : undefined,
            )}
          </Text>
        );
      })}
      {layout.hiddenBelow > 0 ? <Text dimColor>…</Text> : null}
    </Box>
  );
}

function renderLine(
  tokens: readonly { text: string; width: number }[],
  cursorColumn: number | undefined,
): ReactNode[] {
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

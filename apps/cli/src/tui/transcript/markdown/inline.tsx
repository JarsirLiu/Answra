/** 单行 Markdown 行内投影：粗体、内联代码与链接；不做表格或块级解析。 */
import { Text } from "ink";
import type { ReactNode } from "react";
import { TUI_THEME } from "../../chrome/theme";

const INLINE_TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

export function renderInline(text: string, dimColor: boolean): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE_TOKEN)) {
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

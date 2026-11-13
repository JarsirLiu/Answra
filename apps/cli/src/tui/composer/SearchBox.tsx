/** Claude Code 风格搜索框：圆角边框、⌕ 前缀与聚焦色；只渲染查询，不处理按键。 */
import { Box, Text, useWindowSize } from "ink";
import { TUI_THEME } from "../chrome/theme";
import { TextInput } from "./TextInput";

const SEARCH_CHROME_COLUMNS = 10;

export function SearchBox({
  query,
  placeholder,
  isFocused,
}: {
  query: string;
  placeholder: string;
  isFocused: boolean;
}) {
  const { columns } = useWindowSize();
  const inputColumns = Math.max(1, columns - SEARCH_CHROME_COLUMNS);
  return (
    <Box
      borderColor={isFocused ? TUI_THEME.suggestion : undefined}
      borderDimColor={!isFocused}
      borderStyle="round"
      paddingX={1}
      width="100%"
    >
      <Text dimColor={!isFocused}>⌕ </Text>
      <Box flexGrow={1}>
        {isFocused ? (
          <TextInput
            columns={inputColumns}
            cursor={query.length}
            maxVisibleLines={1}
            placeholder={placeholder}
            value={query}
          />
        ) : (
          <Text dimColor>{query === "" ? placeholder : query}</Text>
        )}
      </Box>
    </Box>
  );
}

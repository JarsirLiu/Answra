/** `/config` 设置列表视图：搜索框、label/当前值行与行内编辑器；不负责加载、保存或按键分派。 */
import { Box, Text, useWindowSize } from "ink";
import { POINTER, TUI_THEME } from "../chrome/theme";
import { PromptInput } from "../composer/PromptInput";
import { SearchBox } from "../composer/SearchBox";
import {
  type ConfigField,
  type ConfigFormValues,
  type ConfigPanelData,
  maskApiKeyForInput,
} from "./configForm";
import { type ConfigRowSpec, displayConfigValue } from "./configPresentation";

const CONFIG_LABEL_COLUMNS = 44;
const CONFIG_PANEL_PADDING_COLUMNS = 4;

export function ConfigList({
  data,
  editing,
  error,
  index,
  query,
  revealApiKey,
  rows,
  searchMode,
  values,
  onCancelEdit,
  onToggleSecret,
  onUpdate,
}: {
  data: ConfigPanelData;
  editing: ConfigField | undefined;
  error: string | undefined;
  index: number;
  query: string;
  revealApiKey: boolean;
  rows: readonly ConfigRowSpec[];
  searchMode: boolean;
  values: ConfigFormValues;
  onCancelEdit(): void;
  onToggleSecret(): void;
  onUpdate(field: ConfigField, value: string): void;
}) {
  const { columns } = useWindowSize();
  const valueColumns = Math.max(1, columns - CONFIG_LABEL_COLUMNS - CONFIG_PANEL_PADDING_COLUMNS);
  return (
    <Box flexDirection="column">
      <SearchBox isFocused={searchMode} placeholder="搜索设置…" query={query} />
      <Box flexDirection="column" marginTop={1}>
        {rows.length === 0 ? <Text dimColor>没有匹配的设置</Text> : null}
        {rows.map((row, rowIndex) => {
          const focused = !searchMode && rowIndex === index;
          const isEditing = editing === row.field;
          return (
            <Box key={row.field}>
              <Box width={CONFIG_LABEL_COLUMNS}>
                <Text color={focused ? TUI_THEME.suggestion : TUI_THEME.text}>
                  {focused ? POINTER : " "} {row.label}
                </Text>
              </Box>
              {isEditing ? (
                <Box width={valueColumns}>
                  <PromptInput
                    key={row.field}
                    active
                    allowEmptySubmit
                    busy={false}
                    columns={valueColumns}
                    commandsEnabled={false}
                    exitOnCtrlC={false}
                    historyEnabled={false}
                    idleHint={editorHint(row.field)}
                    initialValue={values[row.field]}
                    marginTop={0}
                    maxVisibleLines={1}
                    onEscape={onCancelEdit}
                    onSubmit={(value) => {
                      onUpdate(row.field, value);
                      onCancelEdit();
                    }}
                    onToggleSecret={row.field === "apiKey" ? onToggleSecret : undefined}
                    secret={row.field === "apiKey" && !revealApiKey}
                    secretMask={row.field === "apiKey" ? maskApiKeyForInput : undefined}
                    showBorder={false}
                    showHints={false}
                    showPointer={false}
                  />
                </Box>
              ) : (
                <Box width={valueColumns}>
                  <Text color={focused ? TUI_THEME.suggestion : undefined} wrap="truncate">
                    {displayConfigValue(row.field, values, data, revealApiKey)}
                  </Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
      {error === undefined ? null : (
        <Box marginTop={1}>
          <Text color={TUI_THEME.error}>{error}</Text>
        </Box>
      )}
    </Box>
  );
}

function editorHint(field: ConfigField): string {
  switch (field) {
    case "baseUrl":
      return "输入 Base URL，Enter 确认";
    case "apiKey":
      return "Enter 保持当前值；Ctrl+U 清空后保存将清除";
    case "chatModel":
      return "输入模型 ID，Enter 确认";
    case "answerModel":
      return "留空表示与 Chat 相同";
  }
}

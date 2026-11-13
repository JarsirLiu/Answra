/** `/config` 列表展示投影：字段标签、搜索过滤、当前值与 footer；不处理按键或 I/O。 */
import {
  CONFIG_FIELDS,
  type ConfigField,
  type ConfigFormValues,
  type ConfigPanelData,
  configApiKeyLabel,
  maskApiKey,
} from "./configForm";

export interface ConfigRowSpec {
  readonly field: ConfigField;
  readonly label: string;
}

const FIELD_LABELS: Record<ConfigField, string> = {
  baseUrl: "Base URL",
  apiKey: "API Key",
  chatModel: "Chat 模型",
  answerModel: "Answer 模型",
};

export const CONFIG_ROWS: readonly ConfigRowSpec[] = CONFIG_FIELDS.map((field) => ({
  field,
  label: FIELD_LABELS[field],
}));

export function filterConfigRows(query: string): readonly ConfigRowSpec[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === "") return CONFIG_ROWS;
  return CONFIG_ROWS.filter((row) => row.label.toLowerCase().includes(normalized));
}

export function displayConfigValue(
  field: ConfigField,
  values: ConfigFormValues,
  data: ConfigPanelData,
  revealApiKey: boolean,
): string {
  switch (field) {
    case "baseUrl":
      return values.baseUrl === "" ? "(未配置)" : values.baseUrl;
    case "apiKey": {
      const label = configApiKeyLabel(data.apiKey, values.apiKey);
      const pending = values.apiKey.trim();
      const preview =
        pending === "" || pending === "-"
          ? ""
          : ` · ${revealApiKey ? pending : maskApiKey(pending)}`;
      return `${label}${preview}`;
    }
    case "chatModel":
      return values.chatModel === "" ? "(未配置)" : values.chatModel;
    case "answerModel":
      return values.answerModel === "" ? "与 Chat 相同" : values.answerModel;
  }
}

export function configPanelFooter(input: {
  readonly busy: boolean;
  readonly loaded: boolean;
  readonly submenu: boolean;
  readonly editing: ConfigField | undefined;
  readonly searching: boolean;
  readonly selectedField?: ConfigField;
}): string {
  if (input.busy) return "正在保存…";
  if (!input.loaded) return "Esc 关闭";
  if (input.submenu) return "↑/↓ 选择 · Enter 确认 · Esc 返回";
  if (input.editing !== undefined) {
    return input.editing === "apiKey"
      ? "Enter 确认 · Ctrl+R 显示/隐藏 · Esc 取消编辑"
      : "Enter 确认 · Esc 取消编辑";
  }
  if (input.searching) return "输入筛选 · Enter/↓ 进入列表 · Esc 清除";
  if (input.selectedField === "apiKey") {
    return "Enter/→ 修改 · Ctrl+R 显示/隐藏 Key · Ctrl+S 保存 · / 搜索 · Esc 取消";
  }
  return "Enter/→ 修改 · Ctrl+S 保存 · / 搜索 · Esc 取消";
}

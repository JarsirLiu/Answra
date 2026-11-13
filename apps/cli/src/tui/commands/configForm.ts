/** `/config` 设置项的纯值对象与投影：字段顺序、必填校验和 API Key 更新意图；不渲染 UI。 */
export type ConfigField = "baseUrl" | "apiKey" | "chatModel" | "answerModel";

export const CONFIG_FIELDS: readonly ConfigField[] = [
  "baseUrl",
  "apiKey",
  "chatModel",
  "answerModel",
];

export interface ConfigPanelData {
  readonly baseUrl: string;
  readonly chatModel: string;
  readonly answerModel?: string;
  /** 已保存的 API Key；只用于回填表单，不进入共享配置或 transcript。 */
  readonly apiKey: string;
}

export interface ConfigFormValues {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly chatModel: string;
  readonly answerModel: string;
}

export type ConfigApiKeyUpdate =
  | { readonly kind: "keep" }
  | { readonly kind: "clear" }
  | { readonly kind: "set"; readonly value: string };

export interface ConfigSaveInput {
  readonly baseUrl: string;
  readonly chatModel: string;
  readonly answerModel?: string;
  readonly apiKey: ConfigApiKeyUpdate;
}

export function configFormFromData(data: ConfigPanelData): ConfigFormValues {
  return {
    baseUrl: data.baseUrl,
    apiKey: data.apiKey,
    chatModel: data.chatModel,
    answerModel: data.answerModel ?? "",
  };
}

export function configSaveInput(values: ConfigFormValues, originalApiKey: string): ConfigSaveInput {
  const answerModel = values.answerModel.trim();
  return {
    baseUrl: values.baseUrl.trim(),
    chatModel: values.chatModel.trim(),
    ...(answerModel === "" ? {} : { answerModel }),
    apiKey: configApiKeyUpdate(values.apiKey, originalApiKey),
  };
}

export function configApiKeyUpdate(value: string, original = ""): ConfigApiKeyUpdate {
  const text = value.trim();
  const originalText = original.trim();
  if (text === originalText) return { kind: "keep" };
  if (text === "" || text === "-") return { kind: "clear" };
  return { kind: "set", value: text };
}

export function configApiKeyLabel(original: string, pending: string): string {
  const update = configApiKeyUpdate(pending, original);
  if (update.kind === "clear") return "将清除";
  if (update.kind === "set") return "将更新";
  return original.trim() === "" ? "(未配置)" : "已保存";
}

/** 配置面板只回显首尾少量字符，默认不把完整 key 写到终端。 */
export function maskApiKey(value: string): string {
  const text = value.trim();
  if (text === "") return "";
  if (text.length <= 8) return "••••";
  return `••••${text.slice(-4)}`;
}

export function validateConfigForm(values: ConfigFormValues): string | undefined {
  if (values.baseUrl.trim() === "") return "请填写 Base URL。";
  if (values.chatModel.trim() === "") return "请填写 Chat 模型 ID。";
  return undefined;
}

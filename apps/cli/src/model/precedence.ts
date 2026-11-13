/** 模型解析优先级：调用方按 flag → env 顺序传入覆盖，逐字段取首个非空值，最后回退共享配置。 */
import { type LocalModelConfig, normalizeBaseUrl } from "@answra/config";
import { AI_SERVICE_BASE_URL, CLI_MODEL, type ConversationModelConfig } from "@answra/shared";
import { MissingModelConfigError } from "./errors";
import type { ModelOverrides } from "./ports";

export function resolveLocalModel(
  overrides: readonly ModelOverrides[],
  local: LocalModelConfig,
): ConversationModelConfig {
  const baseUrlOverride = firstOverride(overrides, (entry) => entry.baseUrl);
  const chatModelOverride = firstOverride(overrides, (entry) => entry.chatModel);
  const baseUrl = normalizeBaseUrl(
    requiredText(
      baseUrlOverride ?? local.baseUrl,
      `缺少 ${AI_SERVICE_BASE_URL}（共享配置也没有本地模型地址）`,
    ),
  );
  const chatModel = requiredText(
    chatModelOverride ?? local.chatModel,
    `缺少 ${CLI_MODEL}（共享配置也没有本地模型 ID）`,
  );
  const answerModel = chatModelOverride ?? optionalText(local.answerModel) ?? chatModel;
  return {
    chat: { baseUrl, model: chatModel, auth: "local" },
    answer: { baseUrl, model: answerModel, auth: "local" },
  };
}

function firstOverride(
  overrides: readonly ModelOverrides[],
  read: (entry: ModelOverrides) => string | undefined,
): string | undefined {
  for (const entry of overrides) {
    const value = optionalText(read(entry));
    if (value !== undefined) return value;
  }
  return undefined;
}

function optionalText(value: string | undefined): string | undefined {
  const text = value?.trim() ?? "";
  return text === "" ? undefined : text;
}

function requiredText(value: string | undefined, message: string): string {
  const text = optionalText(value);
  if (text === undefined) throw new MissingModelConfigError(`${message}。`);
  return text;
}

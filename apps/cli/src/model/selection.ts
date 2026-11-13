/** 用户输入到共享本地模型字段的校验与组装；不读写文件、不解析 argv。 */
import { type LocalModelConfig, normalizeBaseUrl } from "@answra/config";
import type { LocalModelInput } from "./ports";

export function selectLocalModel(input: LocalModelInput): LocalModelConfig {
  const baseUrl = normalizeBaseUrl(requiredText(input.baseUrl, "请填写本地模型地址"));
  const chatModel = requiredText(input.chatModel, "请填写模型 ID");
  const answerModel = optionalText(input.answerModel);
  return {
    baseUrl,
    chatModel,
    ...(answerModel === undefined ? {} : { answerModel }),
  };
}

export function selectChatModel(value: string): string {
  return requiredText(value, "请填写模型 ID");
}

function requiredText(value: string, message: string): string {
  const text = value.trim();
  if (text === "") throw new Error(`${message}。`);
  return text;
}

function optionalText(value: string | undefined): string | undefined {
  const text = value?.trim() ?? "";
  return text === "" ? undefined : text;
}

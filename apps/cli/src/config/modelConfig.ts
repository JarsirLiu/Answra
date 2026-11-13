/** CLI 模型配置：参数/环境变量覆盖共享本地模型配置，最终映射为 Agent 双路端点。 */
import type { ClientConfig } from "@answra/config";
import type { ConversationModelConfig } from "@answra/shared";
import { AI_SERVICE_BASE_URL, CLI_API_KEY, CLI_MODEL } from "@answra/shared";
import { CliConfigError } from "../cli/errors";
import type { CliOptions } from "./cliOptions";

export interface ResolvedCliModel {
  config: ConversationModelConfig;
  accessToken: string;
}

type CodeOptions = Extract<CliOptions, { kind: "code" }>;
type CliEnv = Readonly<Record<string, string | undefined>>;

/** 解析并校验 CLI 的本地模型端点；参数和环境变量优先，其次读共享配置。 */
export function resolveModelConfig(
  options: CodeOptions,
  env: CliEnv,
  shared?: ClientConfig | null,
): ResolvedCliModel {
  const sharedLocal = shared?.model.local;
  const baseUrlOverride = optionalText(options.baseUrl) ?? optionalText(env[AI_SERVICE_BASE_URL]);
  const modelOverride = optionalText(options.model) ?? optionalText(env[CLI_MODEL]);
  const baseUrl = normalizeBaseUrl(baseUrlOverride ?? sharedLocal?.baseUrl);
  const model = requiredText(
    modelOverride ?? sharedLocal?.chatModel,
    `缺少 ${CLI_MODEL}（共享配置也没有本地模型 ID）`,
  );
  const answerModel =
    modelOverride === undefined && sharedLocal?.answerModel ? sharedLocal.answerModel : model;
  const accessToken = (options.apiKey ?? env[CLI_API_KEY] ?? "").trim();
  const chat = { baseUrl, model, auth: "local" as const };
  const answer = { baseUrl, model: answerModel, auth: "local" as const };
  return {
    config: { chat, answer },
    accessToken,
  };
}

function normalizeBaseUrl(value: string | undefined): string {
  const raw = requiredText(value, `缺少 ${AI_SERVICE_BASE_URL}（共享配置也没有本地模型地址）`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliConfigError(`${AI_SERVICE_BASE_URL} 不是合法 URL。`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new CliConfigError(`${AI_SERVICE_BASE_URL} 只支持 http(s)。`);
  if (url.username || url.password)
    throw new CliConfigError(`${AI_SERVICE_BASE_URL} 不能包含账号密码。`);
  return raw.replace(/\/+$/, "");
}

function optionalText(value: string | undefined): string | undefined {
  const text = value?.trim() ?? "";
  return text === "" ? undefined : text;
}

function requiredText(value: string | undefined, message: string): string {
  const text = optionalText(value);
  if (text === undefined) throw new CliConfigError(`${message}。`);
  return text;
}

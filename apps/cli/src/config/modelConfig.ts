/** CLI 模型配置：环境变量与命令行覆盖合并为 Agent 所需的双路由配置。 */

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

/** 解析并校验 CLI 的本地模型端点；缺少必填项时显式失败，不自动兜底。 */
export function resolveModelConfig(options: CodeOptions, env: CliEnv): ResolvedCliModel {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? env[AI_SERVICE_BASE_URL]);
  const model = requiredText(options.model ?? env[CLI_MODEL], `缺少 ${CLI_MODEL}`);
  const accessToken = (options.apiKey ?? env[CLI_API_KEY] ?? "").trim();
  const endpoint = { baseUrl, model, auth: "local" as const };
  return {
    config: { chat: { ...endpoint }, answer: { ...endpoint } },
    accessToken,
  };
}

function normalizeBaseUrl(value: string | undefined): string {
  const raw = requiredText(value, `缺少 ${AI_SERVICE_BASE_URL}`);
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

function requiredText(value: string | undefined, message: string): string {
  const text = value?.trim() ?? "";
  if (!text) throw new CliConfigError(`${message}。`);
  return text;
}

/**
 * 共享 TTS 配置：只保存非 secret 字段，Key 由 `@answra/credentials` 写 OS keychain。
 *
 * 解析与归一都在这里完成，desktop 与未来 CLI 共用同一份盘上格式。
 * 设置页只维护一个 provider；旧版的 `providers[] + activeProviderId` 在读取时迁移。
 */
import { isTtsProtocol, isTtsProviderId } from "@answra/shared";
import { normalizeBaseUrl } from "./baseUrl";
import type { ClientTtsConfig, ClientTtsProviderConfig } from "./contracts";

/** 未配置时的默认值：无 provider（演练保持文字模式）。 */
export function defaultClientTtsConfig(): ClientTtsConfig {
  return { provider: null };
}

/** 只解析已知字段；缺失或不是对象时返回 undefined（保持旧配置兼容）。 */
export function parseClientTtsConfig(value: unknown): ClientTtsConfig | undefined {
  if (!isRecord(value)) return undefined;
  // 旧版的 `enabled` 开关已移除：配置存在 provider 即自动朗读，这里静默忽略旧字段。
  return { provider: parseProviderField(value) };
}

function parseProviderField(value: Record<string, unknown>): ClientTtsProviderConfig | null {
  if (value.provider !== undefined) {
    if (value.provider === null) return null;
    return parseProvider(value.provider, "tts.provider");
  }
  return parseLegacyProvider(value.providers, value.activeProviderId);
}

/** 旧版多 provider 列表：优先取 active，其次取第一项；`strategy` 不再读取。 */
function parseLegacyProvider(
  providersValue: unknown,
  activeValue: unknown,
): ClientTtsProviderConfig | null {
  if (providersValue === undefined || providersValue === null) return null;
  if (!Array.isArray(providersValue)) throw new Error("tts.providers 必须是数组。");

  const providers = providersValue.map((entry, index) =>
    parseProvider(entry, `tts.providers[${index}]`),
  );
  if (activeValue !== undefined && activeValue !== null && typeof activeValue !== "string") {
    throw new Error("tts.activeProviderId 必须是字符串或 null。");
  }
  const activeId = typeof activeValue === "string" ? activeValue.trim() : "";
  return providers.find((provider) => provider.id === activeId) ?? providers[0] ?? null;
}

function parseProvider(value: unknown, field: string): ClientTtsProviderConfig {
  if (!isRecord(value)) throw new Error(`${field} 必须是对象。`);

  const id = readRequiredText(value.id, `${field}.id`);
  if (!isTtsProviderId(id)) {
    throw new Error(`${field}.id 只允许小写字母、数字与连字符，长度 1-32。`);
  }
  if (!isTtsProtocol(value.protocol)) {
    throw new Error(`${field}.protocol 不受支持：${String(value.protocol)}。`);
  }

  return {
    id,
    label: readRequiredText(value.label, `${field}.label`),
    protocol: value.protocol,
    baseUrl: normalizeBaseUrl(readRequiredText(value.baseUrl, `${field}.baseUrl`), "TTS 端点地址"),
    model: readRequiredText(value.model, `${field}.model`),
    voice: readOptionalText(value.voice, `${field}.voice`),
  };
}

function readRequiredText(value: unknown, field: string): string {
  const text = readOptionalText(value, field);
  if (text === "") throw new Error(`${field} 不能为空。`);
  return text;
}

function readOptionalText(value: unknown, field: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error(`${field} 必须是字符串。`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

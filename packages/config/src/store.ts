/** 共享配置的 JSON 读写：边界校验一次，写入原子替换，永不写 secret。 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CLIENT_CONFIG_VERSION, type ClientConfig, type LocalModelConfig } from "./contracts";

const CONFIG_FILE_MODE = 0o600;
const CONFIG_DIR_MODE = 0o700;

export async function readClientConfig(filePath: string): Promise<ClientConfig | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`共享配置不是合法 JSON：${filePath}`, { cause: error });
  }
  return parseClientConfig(parsed);
}

export async function writeClientConfig(filePath: string, config: ClientConfig): Promise<void> {
  const normalized = parseClientConfig(config);
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await mkdir(dir, { recursive: true, mode: CONFIG_DIR_MODE });
  try {
    await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      mode: CONFIG_FILE_MODE,
    });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function parseClientConfig(input: unknown): ClientConfig {
  if (!isRecord(input)) throw new Error("共享配置必须是对象。");
  if (input.version !== CLIENT_CONFIG_VERSION) {
    throw new Error(`不支持的共享配置版本：${String(input.version)}。`);
  }
  if (!isRecord(input.model)) throw new Error("共享配置缺少 model。");
  const source = input.model.source === "local" ? "local" : "cloud";
  if (!isRecord(input.model.local)) throw new Error("共享配置缺少 model.local。");
  const local = parseLocalModel(input.model.local);
  return { version: CLIENT_CONFIG_VERSION, model: { source, local } };
}

function parseLocalModel(input: Record<string, unknown>): LocalModelConfig {
  const rawBaseUrl = readText(input.baseUrl, "model.local.baseUrl");
  const chatModel = readText(input.chatModel, "model.local.chatModel");
  const answerModel = readText(input.answerModel, "model.local.answerModel");
  if ((rawBaseUrl === "") !== (chatModel === "")) {
    throw new Error("model.local.baseUrl 与 model.local.chatModel 必须同时设置或同时留空。");
  }
  const baseUrl = rawBaseUrl === "" ? "" : normalizeBaseUrl(rawBaseUrl);
  return {
    baseUrl,
    chatModel,
    ...(answerModel === "" ? {} : { answerModel }),
  };
}

export function normalizeBaseUrl(value: string): string {
  const raw = value.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("本地模型地址不是合法 URL。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("本地模型地址只支持 http(s)。");
  }
  if (url.username || url.password) {
    throw new Error("本地模型地址不能包含账号密码。");
  }
  return raw.replace(/\/+$/, "");
}

function readText(value: unknown, field: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error(`${field} 必须是字符串。`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

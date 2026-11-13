/** OpenAI 兼容 `/models` 适配器：只做 HTTP、超时、响应校验与去重排序。 */
import { type ModelCatalog, ModelCatalogError, type ModelCatalogInput } from "../model/catalog";

const DEFAULT_TIMEOUT_MS = 5_000;

interface ModelCatalogResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

type ModelCatalogFetch = (
  url: string,
  init: {
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  },
) => Promise<ModelCatalogResponse>;

export interface OpenAiModelCatalogOptions {
  readonly fetchImpl?: ModelCatalogFetch;
  readonly timeoutMs?: number;
}

export function createOpenAiModelCatalog(options: OpenAiModelCatalogOptions = {}): ModelCatalog {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    list: (input) => listModels(input, fetchImpl, timeoutMs),
  };
}

async function listModels(
  input: ModelCatalogInput,
  fetchImpl: ModelCatalogFetch,
  timeoutMs: number,
): Promise<readonly string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const apiKey = input.apiKey?.trim() ?? "";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey !== "") headers.Authorization = `Bearer ${apiKey}`;

  try {
    const response = await fetchImpl(`${input.baseUrl.replace(/\/+$/, "")}/models`, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ModelCatalogError("http", `读取模型列表失败：HTTP ${response.status}`);
    }
    return parseModels(await response.json());
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ModelCatalogError("timeout", "读取模型列表超时，请检查端点是否可达。");
    }
    if (error instanceof ModelCatalogError) throw error;
    throw new ModelCatalogError("invalid-response", `读取模型列表失败：${messageOf(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

function parseModels(payload: unknown): readonly string[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new ModelCatalogError("invalid-response", "读取模型列表失败：响应格式不正确。");
  }
  const ids = new Set<string>();
  for (const entry of payload.data) {
    if (!isRecord(entry) || typeof entry.id !== "string") {
      throw new ModelCatalogError("invalid-response", "读取模型列表失败：模型项缺少 id。");
    }
    const id = entry.id.trim();
    if (id !== "") ids.add(id);
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

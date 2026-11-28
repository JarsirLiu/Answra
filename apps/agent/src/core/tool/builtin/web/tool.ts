/** 免 Key 的联网工具：WebSearch（公开搜索结果）与 WebFetch（公开网页正文）。 */
import type { JSONSchema7 } from "ai";
import {
  defineTool,
  type ToolContext,
  type ToolEntry,
  type ToolFailureCode,
  type ToolHandlerFailure,
} from "../../contracts";
import { WEB_FETCH_TOOL_ID, WEB_SEARCH_TOOL_ID } from "../../ids";
import { WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from "../../names";
import {
  decodeHtmlEntities,
  formatSearchResults,
  htmlToText,
  normalizeText,
  parseBingResults,
} from "./html";
import {
  fetchWebText,
  type WebHttpOptions,
  WebRequestError,
  type WebRequestErrorCode,
} from "./http";

export const WEB_SEARCH_DEFAULT_LIMIT = 5;
export const WEB_SEARCH_MAX_LIMIT = 10;
export const WEB_QUERY_MAX_CHARS = 200;
export const WEB_URL_MAX_CHARS = 2048;
export const WEB_FETCH_MIN_CHARS = 1000;
export const WEB_FETCH_DEFAULT_MAX_CHARS = 20_000;
export const WEB_FETCH_MAX_CHARS = 50_000;

const DEFAULT_SEARCH_ENDPOINT = "https://www.bing.com/search";
const WEB_TIMEOUT_MS = 25_000;
const WEB_MAX_BYTES = 2 * 1024 * 1024;
const WEB_MAX_REDIRECTS = 5;
// 用桌面浏览器 UA 换 Bing 的标准结果页；无 UA 时会拿到精简或跳转页，解析不到结果块。
const WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** WebSearch 的模型可见字符上限；结果条数与摘要长度都由它兜底。 */
const WEB_SEARCH_MAX_MODEL_CHARS = 24_000;
/**
 * `max_chars` 按字符计数，而执行器的 `maxOutputBytes` 与 resultBudget 按 UTF-8 字节计数。
 * 一个 UTF-16 码元最多占 4 字节（中文 3 字节），再留出前缀与截断提示的包装余量，
 * 否则长中文页面会被执行器判成 output-too-large 而不是正常截断。
 */
const WEB_OUTPUT_BYTES_PER_CHAR = 4;
const WEB_OUTPUT_PACKAGING_RESERVE_BYTES = 4_096;

export interface WebSearchInput {
  readonly query: string;
  readonly limit?: number;
}

export interface WebFetchInput {
  readonly url: string;
  readonly max_chars?: number;
}

export interface WebToolsOptions {
  /** 仅用于测试注入；生产走全局 fetch。 */
  readonly fetch?: typeof fetch;
  /** 仅用于测试注入；生产固定 Bing。 */
  readonly searchEndpoint?: string;
}

export interface WebTools {
  readonly webSearch: ToolEntry<WebSearchInput, string>;
  readonly webFetch: ToolEntry<WebFetchInput, string>;
}

/** 两个工具共用的运行期依赖；注入点只在 createWebTools。 */
interface WebRuntime {
  readonly httpOptions: WebHttpOptions;
  readonly searchEndpoint: string;
}

const WEB_SEARCH_DESCRIPTION = [
  "联网搜索公开网页，返回标题、链接和摘要，用于获取训练数据截止后的最新信息；无需 API Key。",
  "`limit` 控制返回条数，默认 5，最多 10。",
  "需要页面正文时，用 WebFetch 抓取结果里的链接。",
  "不访问需要登录的页面；搜索失败时换关键词重试，不要编造结果。",
].join("\n");

const WEB_FETCH_DESCRIPTION = [
  "抓取公开网页并提取纯文本，输入必须是 http(s) URL，无需 API Key。",
  "`max_chars` 控制返回正文长度，默认 20000 字符。",
  "URL 来自 WebSearch 结果或用户明确提供的地址；不访问本机、内网或需要登录的页面。",
  "返回内容可能被截断；脚本、样式和导航标签会被丢弃，不执行页面脚本。",
].join("\n");

const WEB_SEARCH_INPUT_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, maxLength: WEB_QUERY_MAX_CHARS },
    limit: { type: "integer", minimum: 1, maximum: WEB_SEARCH_MAX_LIMIT },
  },
  required: ["query"],
  additionalProperties: false,
};

const WEB_FETCH_INPUT_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    url: { type: "string", minLength: 1, maxLength: WEB_URL_MAX_CHARS },
    max_chars: {
      type: "integer",
      minimum: WEB_FETCH_MIN_CHARS,
      maximum: WEB_FETCH_MAX_CHARS,
    },
  },
  required: ["url"],
  additionalProperties: false,
};

function failure(code: ToolFailureCode, message: string): ToolHandlerFailure {
  return { ok: false, code, message };
}

/** 浏览器侧错误码到工具失败码的唯一映射；新增错误码必须在这里表态。 */
const WEB_FAILURE_CODES: Readonly<Record<WebRequestErrorCode, ToolFailureCode>> = {
  "invalid-url": "invalid-input",
  "blocked-address": "invalid-input",
  "unsupported-content-type": "handler-failed",
  "http-error": "handler-failed",
  network: "handler-failed",
  timeout: "timeout",
  aborted: "aborted",
};

function toHandlerFailure(error: unknown): ToolHandlerFailure {
  if (error instanceof WebRequestError) {
    return failure(WEB_FAILURE_CODES[error.code], error.message);
  }
  return failure("handler-failed", error instanceof Error ? error.message : "网络请求失败");
}

function validateLimit(value: unknown): ToolHandlerFailure | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return failure("invalid-input", "limit 必须是整数");
  }
  if (value < 1 || value > WEB_SEARCH_MAX_LIMIT) {
    return failure("invalid-input", `limit 必须在 1 到 ${WEB_SEARCH_MAX_LIMIT} 之间`);
  }
  return undefined;
}

function validateMaxChars(value: unknown): ToolHandlerFailure | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return failure("invalid-input", "max_chars 必须是整数");
  }
  if (value < WEB_FETCH_MIN_CHARS || value > WEB_FETCH_MAX_CHARS) {
    return failure(
      "invalid-input",
      `max_chars 必须在 ${WEB_FETCH_MIN_CHARS} 到 ${WEB_FETCH_MAX_CHARS} 之间`,
    );
  }
  return undefined;
}

function validateWebSearchInput(input: unknown): ToolHandlerFailure | undefined {
  if (typeof input !== "object" || input === null)
    return failure("invalid-input", "输入必须是对象");
  const candidate = input as { query?: unknown; limit?: unknown };
  if (typeof candidate.query !== "string" || candidate.query.trim().length === 0) {
    return failure("invalid-input", "query 必须是非空字符串");
  }
  if (candidate.query.length > WEB_QUERY_MAX_CHARS) {
    return failure("invalid-input", `query 不能超过 ${WEB_QUERY_MAX_CHARS} 个字符`);
  }
  return validateLimit(candidate.limit);
}

function validateWebFetchInput(input: unknown): ToolHandlerFailure | undefined {
  if (typeof input !== "object" || input === null)
    return failure("invalid-input", "输入必须是对象");
  const candidate = input as { url?: unknown; max_chars?: unknown };
  if (typeof candidate.url !== "string" || candidate.url.trim().length === 0) {
    return failure("invalid-input", "url 必须是非空字符串");
  }
  if (candidate.url.length > WEB_URL_MAX_CHARS) {
    return failure("invalid-input", `url 不能超过 ${WEB_URL_MAX_CHARS} 个字符`);
  }
  return validateMaxChars(candidate.max_chars);
}

async function executeWebSearch(
  input: WebSearchInput,
  context: ToolContext,
  runtime: WebRuntime,
): Promise<string | ToolHandlerFailure> {
  try {
    const query = input.query.trim();
    const limit = input.limit ?? WEB_SEARCH_DEFAULT_LIMIT;
    const url = new URL(runtime.searchEndpoint);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(limit));
    url.searchParams.set("setlang", "zh-CN");
    const page = await fetchWebText(url.toString(), context, runtime.httpOptions);
    return formatSearchResults(query, parseBingResults(page.text, limit));
  } catch (error) {
    return toHandlerFailure(error);
  }
}

async function executeWebFetch(
  input: WebFetchInput,
  context: ToolContext,
  runtime: WebRuntime,
): Promise<string | ToolHandlerFailure> {
  try {
    const page = await fetchWebText(input.url.trim(), context, runtime.httpOptions);
    const text = /html/i.test(page.contentType)
      ? htmlToText(page.text)
      : normalizeText(decodeHtmlEntities(page.text));
    if (text.length === 0) return `页面没有可提取的文本：${page.finalUrl}`;
    const maxChars = input.max_chars ?? WEB_FETCH_DEFAULT_MAX_CHARS;
    const truncated = text.length > maxChars;
    const body = truncated ? `${text.slice(0, maxChars)}\n[内容已截断]` : text;
    const note = page.truncated ? "（响应过大，抓取时已截断）" : "";
    return `抓取 ${page.finalUrl}${note}：\n${body}`;
  } catch (error) {
    return toHandlerFailure(error);
  }
}

function createWebSearchTool(runtime: WebRuntime): ToolEntry<WebSearchInput, string> {
  return defineTool<WebSearchInput, string>({
    id: WEB_SEARCH_TOOL_ID,
    metadata: {
      name: WEB_SEARCH_TOOL_NAME,
      description: WEB_SEARCH_DESCRIPTION,
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      sideEffectScope: "network",
      timeoutMs: WEB_TIMEOUT_MS,
      maxOutputBytes:
        WEB_SEARCH_MAX_MODEL_CHARS * WEB_OUTPUT_BYTES_PER_CHAR + WEB_OUTPUT_PACKAGING_RESERVE_BYTES,
      resultBudget: {
        strategy: "truncate",
        maxModelChars: WEB_SEARCH_MAX_MODEL_CHARS + WEB_OUTPUT_PACKAGING_RESERVE_BYTES,
      },
    },
    inputSchema: WEB_SEARCH_INPUT_SCHEMA,
    validateInput: validateWebSearchInput,
    exposeOutput: true,
    formatModelContent: (output) => output,
    handler: (input, context) => executeWebSearch(input, context, runtime),
  });
}

function createWebFetchTool(runtime: WebRuntime): ToolEntry<WebFetchInput, string> {
  return defineTool<WebFetchInput, string>({
    id: WEB_FETCH_TOOL_ID,
    metadata: {
      name: WEB_FETCH_TOOL_NAME,
      description: WEB_FETCH_DESCRIPTION,
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      sideEffectScope: "network",
      timeoutMs: WEB_TIMEOUT_MS,
      maxOutputBytes:
        WEB_FETCH_MAX_CHARS * WEB_OUTPUT_BYTES_PER_CHAR + WEB_OUTPUT_PACKAGING_RESERVE_BYTES,
      resultBudget: {
        strategy: "truncate",
        maxModelChars: WEB_FETCH_MAX_CHARS + WEB_OUTPUT_PACKAGING_RESERVE_BYTES,
      },
    },
    inputSchema: WEB_FETCH_INPUT_SCHEMA,
    validateInput: validateWebFetchInput,
    exposeOutput: true,
    formatModelContent: (output) => output,
    handler: (input, context) => executeWebFetch(input, context, runtime),
  });
}

/** 建两个网络工具；它们只在被领域 policy 授权后才进入模型请求。 */
export function createWebTools(options: WebToolsOptions = {}): WebTools {
  const runtime: WebRuntime = {
    httpOptions: {
      fetch: options.fetch ?? globalThis.fetch,
      timeoutMs: WEB_TIMEOUT_MS,
      maxBytes: WEB_MAX_BYTES,
      maxRedirects: WEB_MAX_REDIRECTS,
      userAgent: WEB_USER_AGENT,
    },
    searchEndpoint: options.searchEndpoint ?? DEFAULT_SEARCH_ENDPOINT,
  };
  return {
    webSearch: createWebSearchTool(runtime),
    webFetch: createWebFetchTool(runtime),
  };
}

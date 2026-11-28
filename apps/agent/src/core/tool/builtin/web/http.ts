/** 公开 HTTP 取文本：只允许公网 http(s)，跟随有限次重定向，限制响应体大小。 */
import type { ToolContext } from "../../contracts";

export type WebRequestErrorCode =
  | "invalid-url"
  | "blocked-address"
  | "unsupported-content-type"
  | "http-error"
  | "network"
  | "timeout"
  | "aborted";

export class WebRequestError extends Error {
  readonly code: WebRequestErrorCode;

  constructor(code: WebRequestErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WebRequestError";
    this.code = code;
  }
}

export interface WebHttpOptions {
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxRedirects: number;
  readonly userAgent: string;
}

export interface WebTextResponse {
  readonly text: string;
  readonly contentType: string;
  readonly finalUrl: string;
  readonly truncated: boolean;
}

function v4(a: number, b: number, c: number, d: number): number {
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function netmask(bits: number): number {
  return bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
}

const BLOCKED_V4_NETWORKS: readonly (readonly [number, number])[] = [
  [v4(0, 0, 0, 0), netmask(8)],
  [v4(10, 0, 0, 0), netmask(8)],
  [v4(100, 64, 0, 0), netmask(10)],
  [v4(127, 0, 0, 0), netmask(8)],
  [v4(169, 254, 0, 0), netmask(16)],
  [v4(172, 16, 0, 0), netmask(12)],
  [v4(192, 0, 0, 0), netmask(16)],
  [v4(192, 168, 0, 0), netmask(16)],
  [v4(198, 18, 0, 0), netmask(15)],
  [v4(198, 51, 100, 0), netmask(24)],
  [v4(203, 0, 113, 0), netmask(24)],
  [v4(224, 0, 0, 0), netmask(4)],
  [v4(240, 0, 0, 0), netmask(4)],
];

/** 把 URL 解析出来并挡掉本地/内网/非 http(s) 地址；不解析 DNS，只做字面量判定。 */
function assertPublicHttpUrl(value: string, base?: string): URL {
  let url: URL;
  try {
    url = base === undefined ? new URL(value) : new URL(value, base);
  } catch {
    throw new WebRequestError("invalid-url", "无效的 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebRequestError("invalid-url", "只支持 http 或 https 地址");
  }
  if (url.username !== "" || url.password !== "") {
    throw new WebRequestError("invalid-url", "URL 不得包含用户名或密码");
  }
  const host = url.hostname.toLowerCase();
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) {
    throw new WebRequestError("blocked-address", "不允许访问本机地址");
  }
  if (host.includes(":")) {
    // IPv6 字面量（含 ::ffff:IPv4 映射）一律拒绝，避免环回与链路本地绕过。
    throw new WebRequestError("blocked-address", "不允许访问 IPv6 字面量地址");
  }
  const octets = host.split(".");
  if (octets.length === 4 && octets.every((part) => /^\d+$/u.test(part))) {
    const ipv4 = octets.map((part) => Number(part));
    if (ipv4.some((part) => part > 255)) {
      throw new WebRequestError("invalid-url", "无效的 IP 地址");
    }
    const address = v4(
      Number(octets[0] ?? 0),
      Number(octets[1] ?? 0),
      Number(octets[2] ?? 0),
      Number(octets[3] ?? 0),
    );
    const blocked = BLOCKED_V4_NETWORKS.some(
      ([network, mask]) => (address & mask) >>> 0 === network,
    );
    if (blocked) throw new WebRequestError("blocked-address", "不允许访问内网或环回地址");
  }
  return url;
}

function isTextualContentType(contentType: string): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    type === "application/xhtml+xml" ||
    type === "application/javascript" ||
    type === "application/x-www-form-urlencoded" ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 取消响应体只是清理，失败不影响主流程。
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const text = await response.text();
    return { text: text.slice(0, maxBytes), truncated: text.length > maxBytes };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - total;
    if (remaining <= 0) {
      truncated = true;
      await reader.cancel();
      break;
    }
    if (value.byteLength > remaining) {
      chunks.push(value.subarray(0, remaining));
      total = maxBytes;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}

/** 取一个公开网页的文本；重定向目标同样要过地址检查。 */
export async function fetchWebText(
  url: string,
  context: ToolContext,
  options: WebHttpOptions,
): Promise<WebTextResponse> {
  let current = assertPublicHttpUrl(url);
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(options.timeoutMs)]);
  try {
    for (let redirects = 0; ; redirects += 1) {
      const response = await options.fetch(current, {
        method: "GET",
        headers: {
          "user-agent": options.userAgent,
          accept: "text/html,text/plain,application/json,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        redirect: "manual",
        signal,
      });
      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        await discardBody(response);
        if (location === null) throw new WebRequestError("http-error", "重定向响应缺少 Location");
        if (redirects >= options.maxRedirects) {
          throw new WebRequestError("http-error", "重定向次数过多");
        }
        current = assertPublicHttpUrl(location, current.toString());
        continue;
      }
      if (!response.ok) {
        const status = response.status;
        await discardBody(response);
        throw new WebRequestError("http-error", `目标站点返回 HTTP ${status}`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!isTextualContentType(contentType)) {
        await discardBody(response);
        throw new WebRequestError(
          "unsupported-content-type",
          `不支持的内容类型：${contentType.split(";")[0]?.trim() || "未知"}`,
        );
      }
      const body = await readBoundedBody(response, options.maxBytes);
      return {
        text: body.text,
        contentType,
        finalUrl: current.toString(),
        truncated: body.truncated,
      };
    }
  } catch (error) {
    if (error instanceof WebRequestError) throw error;
    if (context.signal.aborted) throw new WebRequestError("aborted", "网络请求已取消");
    if (signal.reason instanceof DOMException && signal.reason.name === "TimeoutError") {
      throw new WebRequestError("timeout", `网络请求超时（${options.timeoutMs}ms）`);
    }
    const detail = error instanceof Error && error.message ? `：${error.message}` : "";
    throw new WebRequestError("network", `无法连接目标站点${detail}`, { cause: error });
  }
}

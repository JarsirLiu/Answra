/** 模型端点校验，以及云端令牌刷新和本地 API Key 的 fetch 适配。 */
import { authRequiredError, type ConversationCapabilityEndpoint } from "@answra/shared";
import { summarizeModelError } from "./errorSummary";

/** 校验可被 Agent 请求的模型端点，拒绝凭据嵌入 URL 的配置。 */
export function validateEndpoint(endpoint: ConversationCapabilityEndpoint): void {
  const url = new URL(endpoint.baseUrl);
  if (
    !(url.protocol === "http:" || url.protocol === "https:") ||
    url.username ||
    url.password ||
    !endpoint.model.trim()
  ) {
    throw new Error("云端模型端点无效");
  }
}

/** 云端请求遇到 401 时向宿主刷新一次令牌，并将最终认证失败归一化。 */
export function createAuthorizedFetch(
  accessToken: string,
  tokenProvider?: (options: { forceRefresh: boolean }) => Promise<string>,
): typeof fetch {
  type FetchInput = Parameters<typeof fetch>[0];
  type FetchInit = Parameters<typeof fetch>[1];
  const send = (token: string, input: FetchInput, init?: FetchInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  return async (input: FetchInput, init?: FetchInit) => {
    const response = await send(accessToken, input, init);
    if (response.status !== 401) return response;
    if (tokenProvider) {
      let refreshed: string | undefined;
      try {
        refreshed = await tokenProvider({ forceRefresh: true });
      } catch (error) {
        console.warn("[agent][run] 令牌刷新失败", summarizeModelError(error));
      }
      if (refreshed && refreshed !== accessToken) {
        const retried = await send(refreshed, input, init);
        if (retried.status !== 401) return retried;
      }
    }
    throw authRequiredError();
  };
}

/** 本地模型只使用本机 API Key，不触发宿主登录或令牌刷新。 */
export function createLocalFetch(apiKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
    else headers.delete("Authorization");
    return fetch(input, { ...init, headers });
  };
}

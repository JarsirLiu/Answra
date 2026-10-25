import { CLOUD_API_BASE_URL, CLOUD_SITE_BASE_URL } from "@answra/shared";

/**
 * 云端端点解析。
 *
 * 规则（沿用 mycluely 的打包版防篡改约束）：
 * - 打包版一律使用内置默认地址，忽略环境变量；
 * - 开发态允许用环境变量指向本地站点/网关，但必须是 http 环回地址，
 *   避免把开发构建指向任意远端。
 */

export const DEFAULT_CLOUD_API_BASE_URL = "https://colorect.cloud";
export const DEFAULT_CLOUD_SITE_BASE_URL = "https://colorect.cloud";

export interface CloudEndpoints {
  apiBaseUrl: string;
  siteBaseUrl: string;
}

export function resolveCloudEndpoints(
  env: Record<string, string | undefined>,
  options: { isPackaged: boolean },
): CloudEndpoints {
  if (options.isPackaged) {
    return { apiBaseUrl: DEFAULT_CLOUD_API_BASE_URL, siteBaseUrl: DEFAULT_CLOUD_SITE_BASE_URL };
  }
  return {
    apiBaseUrl: resolveDevOverride(env[CLOUD_API_BASE_URL], DEFAULT_CLOUD_API_BASE_URL),
    siteBaseUrl: resolveDevOverride(env[CLOUD_SITE_BASE_URL], DEFAULT_CLOUD_SITE_BASE_URL),
  };
}

/** 只接受 http 环回地址；其他值（含 https 远端）忽略并回落默认。 */
export function resolveDevOverride(candidate: string | undefined, fallback: string): string {
  const value = candidate?.trim();
  if (!value) return fallback;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    console.warn("[auth] 忽略非法的云端地址覆盖", value);
    return fallback;
  }
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) {
    console.warn("[auth] 开发态只能把云端地址覆盖为环回 http 地址，已回落默认", value);
    return fallback;
  }
  return value.replace(/\/+$/, "");
}

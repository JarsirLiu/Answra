/**
 * 授权页 URL 与回调地址常量。
 *
 * 流程（Agents 提案 §4.1）：客户端在系统浏览器打开站点授权页 →
 * 用户登录/同意 → 站点 302 到 `answra://auth/callback?code=…&state=…`。
 *
 * 注意：站点授权页的查询参数名（`code_challenge`/`device_*` 等）尚未在网关契约中冻结，
 * 统一在此处生成，契约变更只需改这一个文件。
 */

/** 应用自定义 scheme（深链回调与单实例转发共用）。 */
export const AUTH_SCHEME = "answra";

/** 打包版回调地址（自定义 scheme，由系统转交给本应用）。 */
export const AUTH_CALLBACK_URL = "answra://auth/callback";

/** 回调的 scheme/host/path 组合，用于与待处理登录的 `redirect_uri` 比对。 */
export const AUTH_CALLBACK_TARGET = "answra://auth/callback";

export interface AuthDeviceDescriptor {
  /** 稳定设备标识（本地生成并持久化，不随启动变化）。 */
  id: string;
  /** 展示用设备名，默认取主机名。 */
  name: string;
  /** `process.platform` 值。 */
  os: string;
}

export interface AuthorizeUrlOptions {
  siteBaseUrl: string;
  state: string;
  codeChallenge: string;
  redirectUri: string;
  device: AuthDeviceDescriptor;
  /** 站点语言前缀；缺省 `zh`。 */
  locale?: string;
}

/** 站点授权页路径（不含语言前缀）。 */
export const AUTHORIZE_PAGE_PATH = "/desktop/authorize";

export function buildAuthorizeUrl(options: AuthorizeUrlOptions): string {
  const base = options.siteBaseUrl.endsWith("/") ? options.siteBaseUrl : `${options.siteBaseUrl}/`;
  const locale = (options.locale ?? "zh").replace(/^\/|\/$/g, "");
  const url = new URL(`${locale}${AUTHORIZE_PAGE_PATH}`, base);
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("device_id", options.device.id);
  url.searchParams.set("device_name", options.device.name);
  url.searchParams.set("os", options.device.os);
  return url.toString();
}

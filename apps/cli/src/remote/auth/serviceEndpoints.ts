/** AnswraSite 账号授权与令牌端点；站点地址由组合根决定，默认官方域名。 */
import { REMOTE_SERVICE_BASE_URL } from "@answra/shared/schema";

export const CLI_AUTHORIZE_PAGE_PATH = "/cli/authorize";
export const CLI_AUTHORIZE_CALLBACK_PATH = "/cli/authorize/callback";

export const SERVICE_AUTH_PATHS = {
  exchange: "/api/v1/auth/desktop/exchange",
  refresh: "/api/v1/auth/refresh",
  revoke: "/api/v1/auth/logout",
  profile: "/api/v1/auth/me",
} as const;

export interface AuthDeviceDescriptor {
  id: string;
  name: string;
  os: string;
}

export interface BuildCliAuthorizeUrlOptions {
  siteBaseUrl?: string;
  redirectUri?: string;
  state: string;
  codeChallenge: string;
  device: AuthDeviceDescriptor;
  locale?: string;
}

export function buildCliAuthorizeUrl({
  siteBaseUrl = REMOTE_SERVICE_BASE_URL,
  redirectUri,
  state,
  codeChallenge,
  device,
  locale = "zh",
}: BuildCliAuthorizeUrlOptions): string {
  const base = withTrailingSlash(siteBaseUrl);
  const normalizedLocale = locale.replace(/^\/|\/$/g, "");
  const url = new URL(`${normalizedLocale}${CLI_AUTHORIZE_PAGE_PATH}`, base);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("redirect_uri", redirectUri ?? buildCliRedirectUrl({ siteBaseUrl, locale }));
  url.searchParams.set("device_id", device.id);
  url.searchParams.set("device_name", device.name);
  url.searchParams.set("os", device.os);
  return url.toString();
}

export function buildCliRedirectUrl({
  siteBaseUrl = REMOTE_SERVICE_BASE_URL,
  locale = "zh",
}: {
  siteBaseUrl?: string;
  locale?: string;
} = {}): string {
  const base = withTrailingSlash(siteBaseUrl);
  const normalizedLocale = locale.replace(/^\/|\/$/g, "");
  return new URL(`${normalizedLocale}${CLI_AUTHORIZE_CALLBACK_PATH}`, base).toString();
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

import {
  ANSWRA_ENV,
  CLOUD_API_BASE_URL,
  CLOUD_SITE_BASE_URL,
  parseAnswraEnv,
} from "@answra/shared";
import { REMOTE_SERVICE_BASE_URL } from "@answra/shared/schema";

export interface CliCloudEndpoints {
  apiBaseUrl: string;
  siteBaseUrl: string;
}

export function resolveCliCloudEndpoints(
  env: Readonly<Record<string, string | undefined>>,
  options: { isPackaged: boolean },
): CliCloudEndpoints {
  if (options.isPackaged || parseAnswraEnv(env[ANSWRA_ENV]) === "production") {
    return { apiBaseUrl: REMOTE_SERVICE_BASE_URL, siteBaseUrl: REMOTE_SERVICE_BASE_URL };
  }
  return {
    apiBaseUrl: resolveDevOverride(env[CLOUD_API_BASE_URL], REMOTE_SERVICE_BASE_URL),
    siteBaseUrl: resolveDevOverride(env[CLOUD_SITE_BASE_URL], REMOTE_SERVICE_BASE_URL),
  };
}

export function isPackagedCliRuntime(): boolean {
  return (process.versions as { electron?: string }).electron !== undefined;
}

export function resolveDevOverride(candidate: string | undefined, fallback: string): string {
  const value = candidate?.trim();
  if (!value) return fallback;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fallback;
  }
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) {
    return fallback;
  }
  return value.replace(/\/+$/, "");
}

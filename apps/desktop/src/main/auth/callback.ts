import { AUTH_CALLBACK_TARGET } from "./authorizeUrl";

/**
 * `answra://auth/callback` / 开发态环回回调的解析与目标校验。
 *
 * 只做「URL 形态 + 目标地址」层面的判断；`state` 是否命中待处理登录、
 * 是否过期由 `pendingAuth.ts` 负责。
 */

export type AuthCallbackFailureReason =
  | "invalid-url"
  | "unexpected-target"
  | "denied"
  | "missing-params";

export type AuthCallbackResult =
  | { ok: true; code: string; state: string; target: string }
  | { ok: false; reason: AuthCallbackFailureReason; message?: string };

/** 归一化回调目标：`scheme://host[:port]/path`，用于与本次登录的 redirect_uri 比对。 */
export function normalizeCallbackTarget(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return `${url.protocol}//${url.host}${url.pathname}`.toLowerCase();
}

/** 是否为本应用的授权回调目标（打包深链，或开发态 127.0.0.1 环回）。 */
export function isAuthCallbackTarget(target: string): boolean {
  if (target === AUTH_CALLBACK_TARGET) return true;
  return /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/.test(target);
}

export function parseAuthCallback(raw: string): AuthCallbackResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
  const target = `${url.protocol}//${url.host}${url.pathname}`.toLowerCase();
  if (!isAuthCallbackTarget(target))
    return { ok: false, reason: "unexpected-target", message: target };
  const error = url.searchParams.get("error");
  if (error) {
    return {
      ok: false,
      reason: "denied",
      message: url.searchParams.get("error_description") ?? error,
    };
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return { ok: false, reason: "missing-params" };
  return { ok: true, code, state, target };
}

/** 从进程 argv 里捞出第一个授权回调 URL（Windows/Linux 的 `second-instance` 路径）。 */
export function findAuthCallbackUrl(argv: readonly string[]): string | null {
  for (const arg of argv) {
    const target = normalizeCallbackTarget(arg);
    if (target && isAuthCallbackTarget(target)) return arg;
  }
  return null;
}

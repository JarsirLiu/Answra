/** CLI 账号设备登录：网站 OAuth、一次性回调接收、token 刷新与 keychain 登录态。 */
import { REMOTE_SERVICE_BASE_URL } from "@answra/shared/schema";
import { createAuthState, createPkceChallenge } from "./pkce";
import type { ServiceAuthRecord, ServiceAuthStore } from "./serviceAuthStore";
import {
  type AuthDeviceDescriptor,
  buildCliAuthorizeUrl,
  SERVICE_AUTH_PATHS,
} from "./serviceEndpoints";

const EXPIRY_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const FALLBACK_EXPIRES_IN = 3600;
const AUTH_CALLBACK_TIMEOUT_MS = 5 * 60_000;

export class RemoteAuthRequiredError extends Error {
  constructor(message = "请先运行 `answra auth login` 登录。") {
    super(message);
    this.name = "RemoteAuthRequiredError";
  }
}

export class RemoteAuthTransientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RemoteAuthTransientError";
  }
}

export interface RemoteAuthStatus {
  signedIn: boolean;
  expiresAt: number | null;
  account: string | null;
}

export interface RemoteAuthOptions {
  onAuthorizeUrl?: (url: string) => void | Promise<void>;
  promptCode?: (label: string) => Promise<string>;
}

export interface AuthorizationCallbackReceiver {
  readonly redirectUri: string;
  wait(): Promise<string>;
  close(): Promise<void> | void;
}

export interface RemoteAuthPort {
  login(options?: RemoteAuthOptions): Promise<RemoteAuthStatus>;
  status(): Promise<RemoteAuthStatus>;
  logout(): Promise<RemoteAuthStatus>;
  getAccessToken(): Promise<string>;
}

export interface RemoteAuthDependencies {
  store: ServiceAuthStore;
  device: () => Promise<AuthDeviceDescriptor>;
  promptCode: (label: string) => Promise<string>;
  siteBaseUrl?: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  createAuthorizationCallback?: () => Promise<AuthorizationCallbackReceiver>;
}

export class RemoteAuthService implements RemoteAuthPort {
  private readonly store: ServiceAuthStore;
  private readonly device: () => Promise<AuthDeviceDescriptor>;
  private readonly promptCode: (label: string) => Promise<string>;
  private readonly siteBaseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly createAuthorizationCallback?: () => Promise<AuthorizationCallbackReceiver>;

  constructor(deps: RemoteAuthDependencies) {
    this.store = deps.store;
    this.device = deps.device;
    this.promptCode = deps.promptCode;
    this.siteBaseUrl = deps.siteBaseUrl ?? REMOTE_SERVICE_BASE_URL;
    this.apiBaseUrl = deps.apiBaseUrl ?? REMOTE_SERVICE_BASE_URL;
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.createAuthorizationCallback = deps.createAuthorizationCallback;
  }

  async login({ onAuthorizeUrl, promptCode }: RemoteAuthOptions = {}): Promise<RemoteAuthStatus> {
    const { verifier, challenge } = createPkceChallenge();
    const state = createAuthState();
    const device = await this.device();
    const callback =
      this.createAuthorizationCallback === undefined
        ? undefined
        : await this.createAuthorizationCallback();
    const url = buildCliAuthorizeUrl({
      siteBaseUrl: this.siteBaseUrl,
      ...(callback === undefined ? {} : { redirectUri: callback.redirectUri }),
      state,
      codeChallenge: challenge,
      device,
    });

    try {
      await onAuthorizeUrl?.(url);
      const input =
        callback === undefined
          ? await (promptCode ?? this.promptCode)("等待浏览器完成登录…")
          : await waitForCallback(callback);
      const { code } = parseAuthorizationCodeInput(input, state);
      const tokens = await this.exchange(code, verifier, device);
      const account = await this.fetchAccount(tokens.accessToken).catch(() => null);
      const record: ServiceAuthRecord = { ...tokens, account };
      await this.store.write(record);
      return statusFrom(record);
    } finally {
      await callback?.close();
    }
  }

  async status(): Promise<RemoteAuthStatus> {
    const record = await this.store.read();
    return record === null ? signedOut() : statusFrom(record);
  }

  async logout(): Promise<RemoteAuthStatus> {
    const record = await this.store.read();
    await this.store.clear();
    if (record !== null) {
      await this.revoke(record.refreshToken).catch(() => undefined);
    }
    return signedOut();
  }

  async getAccessToken(): Promise<string> {
    const record = await this.store.read();
    if (record === null) throw new RemoteAuthRequiredError();
    if (record.expiresAt - this.now() > 0) return record.accessToken;
    return (await this.refresh(record)).accessToken;
  }

  private async exchange(
    code: string,
    verifier: string,
    device: AuthDeviceDescriptor,
  ): Promise<Omit<ServiceAuthRecord, "account">> {
    const body = await this.postJson(SERVICE_AUTH_PATHS.exchange, {
      code,
      code_verifier: verifier,
      device,
    });
    return readTokens(body, this.now());
  }

  private async refresh(record: ServiceAuthRecord): Promise<ServiceAuthRecord> {
    let body: unknown;
    try {
      body = await this.postJson(SERVICE_AUTH_PATHS.refresh, {
        refresh_token: record.refreshToken,
        device: await this.device(),
      });
    } catch (error) {
      if (error instanceof ServiceAuthHttpError && isRejected(error.status)) {
        await this.store.clear();
        throw new RemoteAuthRequiredError("登录已过期，请重新运行 `answra auth login`。");
      }
      throw asTransient(error);
    }
    const tokens = readTokens(body, this.now());
    const updated: ServiceAuthRecord = { ...tokens, account: record.account };
    await this.store.write(updated);
    return updated;
  }

  private async revoke(refreshToken: string): Promise<void> {
    await this.postJson(SERVICE_AUTH_PATHS.revoke, {
      refresh_token: refreshToken,
      device: await this.device(),
    });
  }

  private async fetchAccount(accessToken: string): Promise<string | null> {
    const body = await this.request(SERVICE_AUTH_PATHS.profile, {
      method: "GET",
      accessToken,
    });
    return readAccount(body);
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    return this.request(path, { method: "POST", body });
  }

  private async request(
    path: string,
    options: { method: "GET" | "POST"; body?: unknown; accessToken?: string },
  ): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.accessToken !== undefined) {
      headers.authorization = `Bearer ${options.accessToken}`;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.apiBaseUrl).toString(), {
        method: options.method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new RemoteAuthTransientError("无法连接 Answra 登录服务，请稍后重试。", {
        cause: error,
      });
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new RemoteAuthTransientError("登录服务返回了无效响应。", {
        cause: new ServiceAuthHttpError(response.status, path, "response is not JSON"),
      });
    }
    if (!response.ok) {
      throw new ServiceAuthHttpError(response.status, path, `登录服务返回 HTTP ${response.status}`);
    }
    return unwrapEnvelope(payload, response.status, path);
  }
}

async function waitForCallback(callback: AuthorizationCallbackReceiver): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      callback.wait(),
      new Promise<string>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(new RemoteAuthTransientError("登录等待超时，请重新运行 `answra auth login`。")),
          AUTH_CALLBACK_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function unwrapEnvelope(value: unknown, status: number, path: string): unknown {
  if (typeof value === "object" && value !== null && "code" in value && "data" in value) {
    const envelope = value as { code?: unknown; data?: unknown; message?: unknown };
    if (envelope.code !== 0) {
      throw new ServiceAuthHttpError(
        status,
        path,
        typeof envelope.message === "string" ? envelope.message : "登录服务返回业务错误",
      );
    }
    return envelope.data;
  }
  return value;
}

export class ServiceAuthHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "ServiceAuthHttpError";
  }
}

function isRejected(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function asTransient(error: unknown): unknown {
  if (error instanceof RemoteAuthTransientError) return error;
  if (error instanceof ServiceAuthHttpError) {
    return new RemoteAuthTransientError("登录服务暂时不可用，请稍后重试。", { cause: error });
  }
  return error;
}

function readTokens(body: unknown, now: number): Omit<ServiceAuthRecord, "account"> {
  const value = body as Record<string, unknown> | null;
  const accessToken = value?.device_access_token ?? value?.access_token;
  const refreshToken = value?.device_refresh_token ?? value?.refresh_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new RemoteAuthTransientError("登录服务未返回 access token。");
  }
  if (typeof refreshToken !== "string" || refreshToken === "") {
    throw new RemoteAuthTransientError("登录服务未返回 refresh token。");
  }
  const expiresIn =
    typeof value?.expires_in === "number" && Number.isFinite(value.expires_in)
      ? value.expires_in
      : FALLBACK_EXPIRES_IN;
  return {
    accessToken,
    refreshToken,
    expiresAt: now + expiresIn * 1000 - EXPIRY_SKEW_MS,
  };
}

function readAccount(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = body as Record<string, unknown>;
  if (typeof value.email === "string" && value.email !== "") return value.email;
  if (typeof value.username === "string" && value.username !== "") return value.username;
  return null;
}

export function parseAuthorizationCodeInput(
  input: string,
  expectedState: string,
): { code: string; state: string } {
  const trimmed = input.trim();
  let code: string | null = null;
  let state: string | null = null;
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    code = url.searchParams.get("code");
    state = url.searchParams.get("state");
  } else {
    const separator = trimmed.indexOf("#");
    if (separator < 0) throw new Error("授权码格式无效，请粘贴完整的 code#state。");
    code = trimmed.slice(0, separator);
    state = trimmed.slice(separator + 1);
  }
  if (code === null || code === "") throw new Error("授权码缺少 code。");
  if (state !== expectedState) throw new Error("授权码的 state 不匹配，请重新登录。");
  return { code, state };
}

function statusFrom(record: ServiceAuthRecord): RemoteAuthStatus {
  return { signedIn: true, expiresAt: record.expiresAt, account: record.account };
}

function signedOut(): RemoteAuthStatus {
  return { signedIn: false, expiresAt: null, account: null };
}

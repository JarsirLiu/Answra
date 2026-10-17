import type { AuthLoginResult, AuthStatus, DesktopAnnouncement } from "@answra/shared";
import type { AuthDeviceDescriptor } from "./authorizeUrl";
import { buildAuthorizeUrl } from "./authorizeUrl";
import { parseAuthCallback } from "./callback";
import type { AuthCallbackChannel } from "./callbackChannel";
import type { CloudEndpoints } from "./config";
import type { AuthCredentialStore, AuthSessionRecord, AuthTokens } from "./credentialStore";
import { PendingAuthRegistry } from "./pendingAuth";
import type { PendingAuthStore } from "./pendingAuthStore";
import { createAuthState, createPkceChallenge } from "./pkce";

/**
 * 账号登录编排（main 侧唯一持有 token 的地方）。
 *
 * 契约要点：
 * - 浏览器授权 → 深链/环回回调 → `exchange` 换 token → 拉能力目录 → 推送 `AuthStatus`；
 * - token 只存在 main（safeStorage 加密落盘），渲染层只能拿到 {@link AuthStatus}；
 * - 能力门禁是「服务端强制」的，客户端只做展示与提前提示，`capabilities` 不构成授权。
 *
 * 网关路径与参数名以 AnswraSite `desktop-login-unlock-membership.md` 为草案来源，
 * 尚未冻结；全部集中在 {@link AUTH_PATHS} 与 `readTokens`/`readProfile`，冻结后只改这里。
 */

export const AUTH_PATHS = {
  exchange: "/api/v1/auth/desktop/exchange",
  refresh: "/api/v1/auth/desktop/refresh",
  revoke: "/api/v1/auth/desktop/revoke",
  capabilities: "/api/v1/auth/me",
  announcements: "/api/v1/announcements",
} as const;

/** access token 提前视为过期的时间，避免边界上带一个即将失效的 token 发请求。 */
const EXPIRY_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const FALLBACK_EXPIRES_IN = 1800;

export interface AuthServiceDeps {
  endpoints: CloudEndpoints;
  /** 惰性解析设备身份（首次用到时才读盘，避免启动时序竞争）。 */
  device: () => Promise<AuthDeviceDescriptor>;
  credentials: AuthCredentialStore;
  /** 待处理登录的持久化（冷启动深链回跳需要）。 */
  pendingStore: PendingAuthStore;
  /** 打开系统浏览器；失败时抛错。 */
  openExternal: (url: string) => Promise<void>;
  callbackChannel: AuthCallbackChannel;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** 状态变化推送（main → 所有窗口）。 */
  onStatus?: (status: AuthStatus) => void;
  locale?: string;
  log?: (message: string, error?: unknown) => void;
}

export class AuthService {
  private readonly pending = new PendingAuthRegistry();
  private session: AuthSessionRecord | null = null;
  private activeCallback: { redirectUri: string; close(): void } | null = null;
  private loginInFlight = false;
  private refreshInFlight: Promise<AuthStatus> | null = null;
  private devicePromise: Promise<AuthDeviceDescriptor> | null = null;
  private disposed = false;

  constructor(private readonly deps: AuthServiceDeps) {}

  private get now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** 启动时恢复登录态：token 有效直接用，过期则尝试刷新，失败即视为未登录。 */
  async restore(): Promise<AuthStatus> {
    this.pending.restore(await this.deps.pendingStore.load().catch(() => null));
    this.session = await this.deps.credentials.load();
    return this.getStatus();
  }

  async getStatus(): Promise<AuthStatus> {
    const session = this.session;
    if (!session) return this.signedOutStatus();
    if (session.expiresAt - this.now > 0) return this.statusFrom(session);
    return this.refresh();
  }

  async login(): Promise<AuthLoginResult> {
    if (this.loginInFlight) return { opened: false, error: "登录流程已在进行中" };
    this.loginInFlight = true;
    try {
      const { verifier, challenge } = createPkceChallenge();
      const state = createAuthState();
      this.clearPending();
      this.closeActiveCallback();
      const channel = await this.deps.callbackChannel.begin((url) => {
        void this.handleCallbackUrl(url);
      });
      this.activeCallback = channel;
      const { pending } = this.pending.create(
        {
          state,
          verifier,
          redirectUri: channel.redirectUri,
        },
        this.now,
      );
      // 先落盘再打开浏览器：手机上/系统重启后的深链回跳必须能命中这条记录。
      await this.deps.pendingStore.save(pending);
      await this.deps.openExternal(
        buildAuthorizeUrl({
          siteBaseUrl: this.deps.endpoints.siteBaseUrl,
          state,
          codeChallenge: challenge,
          redirectUri: channel.redirectUri,
          device: await this.currentDevice(),
          ...(this.deps.locale ? { locale: this.deps.locale } : {}),
        }),
      );
      return { opened: true };
    } catch (error) {
      this.clearPending();
      this.closeActiveCallback();
      this.deps.log?.("[auth] 无法打开授权页", error);
      return { opened: false, error: error instanceof Error ? error.message : "无法打开授权页" };
    } finally {
      this.loginInFlight = false;
    }
  }

  /**
   * 处理一次授权回跳（深链 URL 或环回回调 URL）。
   *
   * 返回登录后的状态；回调无效/被拒/交换失败时返回 null（不影响既有登录态）。
   */
  async handleCallbackUrl(raw: string): Promise<AuthStatus | null> {
    if (this.disposed) return null;
    const parsed = parseAuthCallback(raw);
    if (!parsed.ok) {
      this.deps.log?.(`[auth] 忽略回调（${parsed.reason}）`, parsed.message);
      return null;
    }
    const consumed = this.pending.consume({ state: parsed.state, target: parsed.target }, this.now);
    // 无论命中与否，这条待处理登录都已作废（一次性 state），持久化记录同步清掉。
    void this.deps.pendingStore.clear().catch(() => undefined);
    if (!consumed.ok) {
      this.deps.log?.(`[auth] 拒绝回调（${consumed.reason}）`);
      return null;
    }
    this.closeActiveCallback();
    try {
      const tokens = await this.exchangeCode(parsed.code, consumed.pending.verifier);
      const profile = await this.fetchProfile(tokens.accessToken).catch((error) => {
        // 交换成功即视为登录成功；能力目录拉取失败只影响门禁展示，下次刷新补回。
        this.deps.log?.("[auth] 能力目录拉取失败", error);
        return { plan: null, capabilities: [] as string[] };
      });
      const session: AuthSessionRecord = { ...tokens, ...profile };
      this.session = session;
      await this.deps.credentials.save(session);
      return this.emitStatus(this.statusFrom(session));
    } catch (error) {
      this.deps.log?.("[auth] 授权码交换失败", error);
      return null;
    }
  }

  async logout(): Promise<AuthStatus> {
    const session = this.session;
    this.clearPending();
    this.closeActiveCallback();
    this.session = null;
    await this.deps.credentials.clear().catch((error) => {
      this.deps.log?.("[auth] 清除本地凭据失败", error);
    });
    if (session) {
      await this.revoke(session.refreshToken).catch((error) => {
        this.deps.log?.("[auth] 撤销 refresh token 失败（本地已登出）", error);
      });
    }
    return this.emitStatus(this.signedOutStatus());
  }

  async listAnnouncements(): Promise<DesktopAnnouncement[]> {
    const status = await this.getStatus();
    if (!status.signedIn || !this.session) return [];
    return readAnnouncements(
      await this.request(AUTH_PATHS.announcements, undefined, this.session.accessToken),
    );
  }

  async markAnnouncementRead(id: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("公告 ID 无效");
    const status = await this.getStatus();
    if (!status.signedIn || !this.session) throw new Error("请先登录");
    await this.request(`${AUTH_PATHS.announcements}/${id}/read`, {}, this.session.accessToken);
  }

  dispose(): void {
    this.disposed = true;
    this.clearPending();
    this.closeActiveCallback();
  }

  private clearPending(): void {
    this.pending.clear();
    void this.deps.pendingStore.clear().catch(() => undefined);
  }

  private async refresh(): Promise<AuthStatus> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const running = this.doRefresh().finally(() => {
      if (this.refreshInFlight === running) this.refreshInFlight = null;
    });
    this.refreshInFlight = running;
    return running;
  }

  private async doRefresh(): Promise<AuthStatus> {
    const session = this.session;
    if (!session) return this.signedOutStatus();
    try {
      const body = await this.request(AUTH_PATHS.refresh, {
        refresh_token: session.refreshToken,
        device: await this.currentDevice(),
      });
      const tokens = readTokens(body, this.now);
      const merged: AuthSessionRecord = {
        ...tokens,
        plan: session.plan,
        capabilities: session.capabilities,
      };
      this.session = merged;
      await this.deps.credentials.save(merged);
      return this.emitStatus(this.statusFrom(merged));
    } catch (error) {
      this.deps.log?.("[auth] 刷新失败，按未登录处理", error);
      return this.dropSession();
    }
  }

  private async exchangeCode(code: string, verifier: string): Promise<AuthTokens> {
    const body = await this.request(AUTH_PATHS.exchange, {
      code,
      code_verifier: verifier,
      device: await this.currentDevice(),
    });
    return readTokens(body, this.now);
  }

  private async fetchProfile(
    accessToken: string,
  ): Promise<{ plan: string | null; capabilities: string[] }> {
    return readProfile(await this.request(AUTH_PATHS.capabilities, undefined, accessToken));
  }

  private async revoke(refreshToken: string): Promise<void> {
    await this.request(AUTH_PATHS.revoke, {
      refresh_token: refreshToken,
      device: await this.currentDevice(),
    });
  }

  private currentDevice(): Promise<AuthDeviceDescriptor> {
    this.devicePromise ??= this.deps.device();
    return this.devicePromise;
  }

  private async request(path: string, body?: unknown, accessToken?: string): Promise<unknown> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    const response = await fetchImpl(`${this.deps.endpoints.apiBaseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${path} 返回 ${response.status}`);
    const payload = (await response.json()) as unknown;
    if (typeof payload === "object" && payload !== null && "code" in payload && "data" in payload) {
      const envelope = payload as { code?: unknown; data?: unknown; message?: unknown };
      if (envelope.code !== 0) {
        throw new Error(
          typeof envelope.message === "string" ? envelope.message : `${path} 请求失败`,
        );
      }
      return envelope.data;
    }
    return payload;
  }

  private async dropSession(): Promise<AuthStatus> {
    this.session = null;
    await this.deps.credentials.clear().catch(() => undefined);
    return this.emitStatus(this.signedOutStatus());
  }

  private statusFrom(session: AuthSessionRecord): AuthStatus {
    return {
      signedIn: true,
      plan: session.plan,
      capabilities: [...session.capabilities],
      cloudBaseUrl: this.deps.endpoints.apiBaseUrl,
    };
  }

  private signedOutStatus(): AuthStatus {
    return { signedIn: false, plan: null, capabilities: [], cloudBaseUrl: null };
  }

  private emitStatus(status: AuthStatus): AuthStatus {
    this.deps.onStatus?.(status);
    return status;
  }

  private closeActiveCallback(): void {
    const active = this.activeCallback;
    this.activeCallback = null;
    if (!active) return;
    try {
      active.close();
    } catch (error) {
      this.deps.log?.("[auth] 关闭回调通道失败", error);
    }
  }
}

/** 解析网关 token 响应（`expires_in` 为秒）。 */
export function readTokens(body: unknown, now: number): AuthTokens {
  const value = body as Record<string, unknown> | null;
  const accessToken = value?.device_access_token ?? value?.access_token;
  const refreshToken = value?.device_refresh_token ?? value?.refresh_token;
  if (typeof accessToken !== "string" || !accessToken) throw new Error("网关未返回 access token");
  if (typeof refreshToken !== "string" || !refreshToken)
    throw new Error("网关未返回 refresh token");
  const expiresIn = typeof value?.expires_in === "number" ? value.expires_in : FALLBACK_EXPIRES_IN;
  return {
    accessToken,
    refreshToken,
    expiresAt: now + expiresIn * 1000 - EXPIRY_SKEW_MS,
  };
}

/** 解析能力目录响应：只认能力 ID，其他字段一律忽略（客户端不解释模型/端点）。 */
export function readProfile(body: unknown): { plan: string | null; capabilities: string[] } {
  const value = body as Record<string, unknown> | null;
  const rawCapabilities = value?.capabilities;
  const capabilities = Array.isArray(rawCapabilities)
    ? rawCapabilities
        .map((entry) =>
          typeof entry === "string"
            ? entry
            : typeof (entry as { id?: unknown } | null)?.id === "string"
              ? (entry as { id: string }).id
              : null,
        )
        .filter((id): id is string => id !== null)
    : [];
  return {
    plan: typeof value?.plan === "string" ? value.plan : null,
    capabilities,
  };
}

export function readAnnouncements(body: unknown): DesktopAnnouncement[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((entry): DesktopAnnouncement[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const value = entry as Record<string, unknown>;
    if (
      typeof value.id !== "number" ||
      !Number.isSafeInteger(value.id) ||
      value.id <= 0 ||
      typeof value.title !== "string" ||
      typeof value.content !== "string"
    )
      return [];
    return [
      {
        id: value.id,
        title: value.title,
        content: value.content,
        notifyMode: value.notify_mode === "popup" ? "popup" : "silent",
        readAt: typeof value.read_at === "string" ? value.read_at : null,
        createdAt: typeof value.created_at === "string" ? value.created_at : "",
      },
    ];
  });
}

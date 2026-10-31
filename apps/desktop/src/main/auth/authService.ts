import {
  type AuthAccountInfo,
  type AuthLoginResult,
  type AuthQuotaInfo,
  type AuthStatus,
  authRequiredError,
  type ConversationCapabilityEndpoint,
  type ConversationModelConfig,
  type DesktopAnnouncement,
  DesktopCapability,
} from "@answra/shared";
import type { AuthDeviceDescriptor } from "./authorizeUrl";
import { buildAuthorizeUrl } from "./authorizeUrl";
import { parseAuthCallback } from "./callback";
import type { AuthCallbackChannel } from "./callbackChannel";
import type { CloudEndpoints } from "./config";
import type {
  AuthCapabilityEndpoint,
  AuthCredentialStore,
  AuthSessionRecord,
  AuthTokens,
} from "./credentialStore";
import { PendingAuthRegistry } from "./pendingAuth";
import type { PendingAuthStore } from "./pendingAuthStore";
import { createAuthState, createPkceChallenge } from "./pkce";

/**
 * 账号登录编排（main 侧唯一持有 token 的地方）。
 *
 * 契约要点：
 * - 浏览器授权 → 深链/环回回调 → `exchange` 换 token → 拉能力目录 → 推送 `AuthStatus`；
 * - token 只存在 main（safeStorage 加密落盘），渲染层只能拿到 {@link AuthStatus}；
 * - 能力门禁是「服务端强制」的，客户端只做展示与提前提示，`capabilities` 不构成授权；
 * - 刷新失败要分类：只有服务端明确拒绝（4xx）才丢凭据，网络/超时/5xx 保留登录态并冷却重试。
 *
 * 网关路径与参数名以 AnswraSite `desktop-login-unlock-membership.md` 为草案来源，
 * 尚未冻结；全部集中在 {@link AUTH_PATHS} 与 `readTokens`/`readProfile`，冻结后只改这里。
 */

export const AUTH_PATHS = {
  exchange: "/api/v1/auth/desktop/exchange",
  refresh: "/api/v1/auth/refresh",
  revoke: "/api/v1/auth/logout",
  profile: "/api/v1/auth/me",
  capabilities: "/api/v1/capabilities",
  quota: "/api/v1/user/quota",
  announcements: "/api/v1/announcements",
} as const;

/** access token 提前视为过期的时间，避免边界上带一个即将失效的 token 发请求。 */
const EXPIRY_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** 网关未回 `expires_in` 时的保守默认：网关默认 access token 为 24h，这里取 1h 只影响刷新频率。 */
const FALLBACK_EXPIRES_IN = 3600;
/** 临时性刷新失败后的冷却：冷却期内不再重试，避免离线时每次查询都等一次超时。 */
const REFRESH_RETRY_COOLDOWN_MS = 60_000;
/** 与「稍后重试」等价的 4xx：请求超时与限流，不代表凭据失效。 */
const TRANSIENT_STATUS_CODES = new Set([408, 429]);
/**
 * 服务端声明的桌面端点后缀。
 *
 * 目录给出的是完整调用路径（如 `/api/v1/desktop/chat/completions`），而 OpenAI 兼容客户端
 * 需要的是 base URL（自己会补 `/chat/completions`）；这里按后缀裁剪，路径本体仍由服务端决定。
 */
const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

/**
 * 网关请求失败。
 *
 * 保留 HTTP 状态码供调用方分类：只有服务端明确拒绝（4xx）才意味着凭据/账号不可用，
 * 网络错误、超时与 5xx 都属于临时失败，不得据此丢弃本地登录态。
 */
export class CloudRequestError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "CloudRequestError";
  }
}

/** 服务端是否明确拒绝（凭据或账号不可用）。非网关错误一律按临时失败处理。 */
export function isRejectedByServer(error: unknown): boolean {
  return (
    error instanceof CloudRequestError &&
    error.status >= 400 &&
    error.status < 500 &&
    !TRANSIENT_STATUS_CODES.has(error.status)
  );
}

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
  /** 是否已完成一次 `restore()`：未完成时登录态未知，门禁不得按未登录处理。 */
  private restored = false;
  /** 上次临时性刷新失败后的冷却截止时间（epoch ms）。 */
  private refreshRetryAt = 0;

  constructor(private readonly deps: AuthServiceDeps) {}

  private get now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** 启动时恢复登录态：token 有效直接用，过期则尝试刷新；仅在服务端明确拒绝时视为未登录。 */
  async restore(): Promise<AuthStatus> {
    try {
      this.pending.restore(await this.deps.pendingStore.load().catch(() => null));
      this.session = await this.deps.credentials.load();
      const needsRefresh = Boolean(this.session && this.session.expiresAt - this.now <= 0);
      const status = await this.getStatus();
      if (status.signedIn && this.session && !needsRefresh) {
        return this.refreshDirectory(this.session.accessToken);
      }
      return status;
    } finally {
      this.restored = true;
    }
  }

  async getStatus(): Promise<AuthStatus> {
    const session = this.session;
    if (!session) return this.signedOutStatus();
    if (session.expiresAt - this.now > 0) return this.statusFrom(session);
    // 临时失败后的冷却期内不再重试：直接返回缓存登录态，避免离线/网关抖动时每次查询都等一次超时。
    if (this.now < this.refreshRetryAt) return this.statusFrom(session);
    return this.refresh();
  }

  /**
   * 强制从云端同步账号与额度快照：账户面板每次打开时调用。
   *
   * access token 仍有效时只重拉画像（能力目录、账号、额度），不消耗 refresh token；
   * 已过期则走与 getStatus 相同的刷新/冷却路径。失败时回退本地缓存，不影响登录态。
   */
  async syncStatus(): Promise<AuthStatus> {
    const session = this.session;
    if (!session) return this.signedOutStatus();
    if (session.expiresAt - this.now > 0) return this.refreshDirectory(session.accessToken);
    if (this.now < this.refreshRetryAt) return this.statusFrom(session);
    return this.refresh();
  }

  /**
   * 本机是否持有登录会话（同步，不触发刷新或网络请求）。
   *
   * 登录态尚未从磁盘恢复完时按「有会话」处理：冷启动首屏不能因为还没读完本地凭据
   * 就把已登录用户判成未登录。这里只决定要不要提前提示登录，真实授权始终由服务端强制。
   */
  hasSession(): boolean {
    return this.session !== null || !this.restored;
  }

  /**
   * 组装 agent 运行所需的云端模型配置。
   *
   * 端点全部来自服务端下发的能力目录（origin 用本地配置的 API 基地址），客户端不拼路径、
   * 不猜模型名：目录缺任一能力即视为云端暂不可用，返回 null 让调用方给出可重试提示。
   */
  getDesktopModelConfig(): ConversationModelConfig | null {
    const session = this.session;
    if (!session) return null;
    const chat = this.capabilityEndpoint(session, DesktopCapability.TextChat);
    const answer = this.capabilityEndpoint(session, DesktopCapability.ImageAnswer);
    if (!chat || !answer) {
      this.deps.log?.("[auth] 能力目录缺少桌面端点", {
        chat: Boolean(chat),
        answer: Boolean(answer),
      });
      return null;
    }
    return { chat, answer };
  }

  /**
   * 取一次用于云端模型调用的访问令牌。
   *
   * 未登录抛 {@link authRequiredError}（渲染层据此提示登录）；已过期先按 `getStatus` 的
   * 同一冷却语义刷新一次，刷新后仍不可用则抛可重试错误——绝不把过期令牌发出去。
   */
  async getAccessToken(): Promise<string> {
    const session = this.session;
    if (!session) throw authRequiredError();
    if (session.expiresAt - this.now > 0) return session.accessToken;
    await this.getStatus();
    return this.requireUsableToken();
  }

  /** 云端返回 401 后强制刷新一次令牌（模型调用的单次重试）。 */
  async refreshAccessToken(): Promise<string> {
    if (!this.session) throw authRequiredError();
    await this.refresh();
    return this.requireUsableToken();
  }

  private requireUsableToken(): string {
    const session = this.session;
    if (!session) throw authRequiredError();
    if (session.expiresAt - this.now <= 0) throw new Error("云端凭据暂时不可用，请稍后重试");
    return session.accessToken;
  }

  private capabilityEndpoint(
    session: AuthSessionRecord,
    capabilityId: string,
  ): ConversationCapabilityEndpoint | null {
    const declared = session.endpoints.find((endpoint) => endpoint.id === capabilityId);
    if (!declared?.path.endsWith(CHAT_COMPLETIONS_SUFFIX)) return null;
    const origin = this.deps.endpoints.apiBaseUrl.replace(/\/+$/, "");
    return {
      baseUrl: `${origin}${declared.path.slice(0, -CHAT_COMPLETIONS_SUFFIX.length)}`,
      model: declared.model || capabilityId,
      auth: "cloud",
    };
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
        // 交换成功即视为登录成功；画像拉取失败只影响展示，下次刷新补回。
        this.deps.log?.("[auth] 账号画像拉取失败", error);
        return {
          plan: null,
          account: null,
          quota: null,
          capabilities: [] as string[],
          endpoints: [],
        };
      });
      const session: AuthSessionRecord = { ...tokens, ...profile };
      this.session = session;
      this.refreshRetryAt = 0;
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
      await this.request(
        `${AUTH_PATHS.announcements}?platform=desktop`,
        undefined,
        this.session.accessToken,
      ),
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
      const profile = await this.fetchProfile(tokens.accessToken, {
        account: session.account ?? null,
        quota: session.quota ?? null,
      }).catch((error) => {
        this.deps.log?.("[auth] 刷新后账号画像拉取失败", error);
        return {
          plan: session.plan,
          account: session.account ?? null,
          quota: session.quota ?? null,
          capabilities: session.capabilities,
          endpoints: session.endpoints,
        };
      });
      const merged: AuthSessionRecord = {
        ...tokens,
        ...profile,
      };
      this.session = merged;
      this.refreshRetryAt = 0;
      await this.deps.credentials.save(merged);
      return this.emitStatus(this.statusFrom(merged));
    } catch (error) {
      if (isRejectedByServer(error)) {
        // 服务端明确拒绝（401/403 等）：refresh token 确实失效，只能重新登录。
        this.deps.log?.("[auth] 刷新被服务端拒绝，按未登录处理", error);
        return this.dropSession();
      }
      // 网络错误、超时、5xx：保留本地凭据并进入冷却，等网络恢复后自动补刷。
      // 直接清凭据会让用户离线启动一次就必须重走浏览器登录。
      this.refreshRetryAt = this.now + REFRESH_RETRY_COOLDOWN_MS;
      this.deps.log?.("[auth] 刷新暂时失败，保留本地登录态", error);
      return this.statusFrom(session);
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

  /**
   * 拉取账号画像：能力目录 + 账号展示信息 + 套餐额度。
   *
   * 容错边界：能力目录是准入依据，请求失败时向上抛（调用方沿用旧画像）；
   * 账号与额度只是展示信息，单项失败时回退到调用方给的旧值，不能因此把用户挡在登录态之外。
   */
  private async fetchProfile(
    accessToken: string,
    fallback: { account: AuthAccountInfo | null; quota: AuthQuotaInfo | null } = {
      account: null,
      quota: null,
    },
  ): Promise<{
    plan: string | null;
    account: AuthAccountInfo | null;
    quota: AuthQuotaInfo | null;
    capabilities: string[];
    endpoints: AuthCapabilityEndpoint[];
  }> {
    const directory = readProfile(
      await this.request(AUTH_PATHS.capabilities, undefined, accessToken),
    );
    const [account, quota] = await Promise.all([
      this.fetchAccount(accessToken).catch((error) => {
        this.deps.log?.("[auth] 账号信息拉取失败", error);
        return fallback.account;
      }),
      this.fetchQuota(accessToken).catch((error) => {
        this.deps.log?.("[auth] 套餐额度拉取失败", error);
        return fallback.quota;
      }),
    ]);
    return { ...directory, account, quota };
  }

  private async fetchAccount(accessToken: string): Promise<AuthAccountInfo | null> {
    return readAccount(await this.request(AUTH_PATHS.profile, undefined, accessToken));
  }

  private async fetchQuota(accessToken: string): Promise<AuthQuotaInfo | null> {
    return readQuota(await this.request(AUTH_PATHS.quota, undefined, accessToken));
  }

  private async refreshDirectory(accessToken: string): Promise<AuthStatus> {
    const session = this.session;
    if (!session) return this.signedOutStatus();
    try {
      const profile = await this.fetchProfile(accessToken, {
        account: session.account ?? null,
        quota: session.quota ?? null,
      });
      const updated = { ...session, ...profile };
      this.session = updated;
      await this.deps.credentials.save(updated);
      return this.emitStatus(this.statusFrom(updated));
    } catch (error) {
      this.deps.log?.("[auth] 账号画像刷新失败", error);
      return this.statusFrom(session);
    }
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
    // 站点按 Accept-Language 本地化套餐名；不传时服务端回默认语言。
    if (this.deps.locale) headers["accept-language"] = this.deps.locale;
    const response = await fetchImpl(`${this.deps.endpoints.apiBaseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok)
      throw new CloudRequestError(response.status, path, `${path} 返回 ${response.status}`);
    const payload = (await response.json()) as unknown;
    if (typeof payload === "object" && payload !== null && "code" in payload && "data" in payload) {
      const envelope = payload as { code?: unknown; data?: unknown; message?: unknown };
      if (envelope.code !== 0) {
        throw new CloudRequestError(
          response.status,
          path,
          typeof envelope.message === "string" ? envelope.message : `${path} 请求失败`,
        );
      }
      return envelope.data;
    }
    return payload;
  }

  private async dropSession(): Promise<AuthStatus> {
    this.session = null;
    this.refreshRetryAt = 0;
    await this.deps.credentials.clear().catch(() => undefined);
    return this.emitStatus(this.signedOutStatus());
  }

  private statusFrom(session: AuthSessionRecord): AuthStatus {
    return {
      signedIn: true,
      plan: session.plan,
      account: session.account ?? null,
      quota: session.quota ?? null,
      capabilities: [...session.capabilities],
      cloudBaseUrl: this.deps.endpoints.apiBaseUrl,
    };
  }

  private signedOutStatus(): AuthStatus {
    return {
      signedIn: false,
      plan: null,
      account: null,
      quota: null,
      capabilities: [],
      cloudBaseUrl: null,
    };
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

/**
 * 解析能力目录响应：能力 ID 用于展示与门禁提示，`endpoints[]` 用于取调用路径与占位模型。
 *
 * 两者都只做形状校验：客户端不解释模型含义，也不猜测缺失的端点（缺就当作云端不可用，
 * 由服务端升级目录来恢复），因此旧网关只回 `capabilities` 时行为退化为「模型调用不可用」。
 */
export function readProfile(body: unknown): {
  plan: string | null;
  capabilities: string[];
  endpoints: AuthCapabilityEndpoint[];
} {
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
    endpoints: readProfileEndpoints(value?.endpoints),
  };
}

function readProfileEndpoints(value: unknown): AuthCapabilityEndpoint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): AuthCapabilityEndpoint[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const endpoint = entry as Record<string, unknown>;
    if (
      typeof endpoint.id !== "string" ||
      typeof endpoint.path !== "string" ||
      typeof endpoint.model !== "string"
    )
      return [];
    return [{ id: endpoint.id, path: endpoint.path, model: endpoint.model }];
  });
}

/**
 * 解析账号展示信息（`GET /api/v1/auth/me` 的 data）。
 * 只取可展示字段且一律可空：站点允许用户名/邮箱二选一登录，缺哪个都不算错误。
 */
export function readAccount(body: unknown): AuthAccountInfo | null {
  if (typeof body !== "object" || body === null) return null;
  const value = body as Record<string, unknown>;
  const email = typeof value.email === "string" && value.email ? value.email : null;
  const username = typeof value.username === "string" && value.username ? value.username : null;
  if (!email && !username) return null;
  return { email, username };
}

/**
 * 解析网关的积分额度摘要；额度与周期状态由服务端计算，客户端不读取余额金额。
 */
export function readQuota(body: unknown): AuthQuotaInfo | null {
  if (typeof body !== "object" || body === null) return null;
  const value = body as Record<string, unknown>;
  const periods = Array.isArray(value.periods)
    ? value.periods.filter(
        (period): period is Record<string, unknown> =>
          typeof period === "object" && period !== null,
      )
    : [];
  const period = periods.find((item) => item.name === "monthly") ?? periods[0];
  const usedCredits =
    typeof period?.used_credits === "number" && Number.isFinite(period.used_credits)
      ? period.used_credits
      : null;
  const totalCredits =
    typeof period?.total_credits === "number" && Number.isFinite(period.total_credits)
      ? period.total_credits
      : null;
  const usedPercent =
    usedCredits !== null && totalCredits !== null && totalCredits > 0
      ? Math.min(100, Math.max(0, (usedCredits / totalCredits) * 100))
      : null;
  const expiresAt = typeof value.expires_at === "string" ? value.expires_at : null;
  const daysRemaining =
    typeof value.days_remaining === "number" &&
    Number.isFinite(value.days_remaining) &&
    value.days_remaining >= 0
      ? value.days_remaining
      : null;
  const kind = value.kind === "subscription" || value.kind === "default" ? value.kind : undefined;
  const planName = typeof value.plan_name === "string" && value.plan_name ? value.plan_name : null;
  const availableCredits =
    typeof value.available_credits === "number" && Number.isFinite(value.available_credits)
      ? Math.max(0, value.available_credits)
      : null;
  const welfareCredits =
    typeof value.welfare_credits === "number" && Number.isFinite(value.welfare_credits)
      ? Math.max(0, value.welfare_credits)
      : null;
  const accountCredits =
    typeof value.account_credits === "number" && Number.isFinite(value.account_credits)
      ? Math.max(0, value.account_credits)
      : null;
  const welfareExpiresAt =
    typeof value.welfare_expires_at === "string" ? value.welfare_expires_at : null;
  if (kind === undefined || availableCredits === null) return null;
  return {
    kind,
    planName,
    usedPercent,
    usedCredits,
    totalCredits,
    availableCredits,
    welfareCredits,
    accountCredits,
    welfareExpiresAt,
    expiresAt,
    daysRemaining,
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
        platform: value.platform === "web" ? "web" : "desktop",
        startsAt: typeof value.starts_at === "string" ? value.starts_at : null,
        endsAt: typeof value.ends_at === "string" ? value.ends_at : null,
        readAt: typeof value.read_at === "string" ? value.read_at : null,
        createdAt: typeof value.created_at === "string" ? value.created_at : "",
        updatedAt: typeof value.updated_at === "string" ? value.updated_at : "",
      },
    ];
  });
}

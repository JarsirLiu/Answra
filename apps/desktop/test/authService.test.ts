import type { AuthStatus } from "@answra/shared";
import { describe, expect, it, vi } from "vitest";
import {
  AUTH_PATHS,
  AuthService,
  readAccount,
  readAnnouncements,
  readProfile,
  readQuota,
  readTokens,
} from "../src/main/auth/authService";
import type { AuthCallbackChannel } from "../src/main/auth/callbackChannel";
import type { AuthCredentialStore, AuthSessionRecord } from "../src/main/auth/credentialStore";
import type { PendingAuth } from "../src/main/auth/pendingAuth";
import { PENDING_AUTH_TTL_MS } from "../src/main/auth/pendingAuth";
import type { PendingAuthStore } from "../src/main/auth/pendingAuthStore";
import { pkceChallengeFromVerifier } from "../src/main/auth/pkce";

/**
 * AuthService 编排单测：全程注入 fake fetch / 内存存储 / 假回调通道，
 * 不加载 Electron，也不真正打开浏览器。
 */

interface RecordedCall {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
  authorization: string | undefined;
}

const DEVICE = { id: "device-1", name: "test-host", os: "win32" };
const TEST_NOW = 1_700_000_000_000;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function tokenBody(access = "access-1", refresh = "refresh-1", expiresIn = 3600): unknown {
  return { device_access_token: access, device_refresh_token: refresh, expires_in: expiresIn };
}

function createHarness(
  handle: (call: RecordedCall) => Response | Promise<Response>,
  options: { now?: () => number } = {},
) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      authorization: headers.authorization,
    });
    return handle(calls[calls.length - 1]);
  }) as unknown as typeof fetch;
  const credentials = memoryCredentialStore();
  const pending = memoryPendingStore();
  const statuses: AuthStatus[] = [];
  const opened: string[] = [];
  let deliver: ((url: string) => void) | null = null;
  const callbackChannel: AuthCallbackChannel = {
    begin: async (onCallback) => {
      deliver = onCallback;
      return { redirectUri: "answra://auth/callback", close: () => (deliver = null) };
    },
  };
  const service = new AuthService({
    endpoints: { apiBaseUrl: "https://api.test", siteBaseUrl: "https://site.test" },
    device: async () => DEVICE,
    credentials: credentials.store,
    pendingStore: pending.store,
    openExternal: async (url) => {
      opened.push(url);
    },
    callbackChannel,
    fetchImpl,
    now: options.now ?? (() => TEST_NOW),
    onStatus: (status) => statuses.push(status),
  });
  return {
    service,
    calls,
    credentials,
    pending,
    statuses,
    opened,
    /** 模拟环回/深链通道把 URL 送进来（走的是服务内部注册的回调）。 */
    deliverCallbackUrl: (url: string) => {
      if (!deliver) throw new Error("callback channel was not started");
      deliver(url);
    },
  };
}

function memoryCredentialStore() {
  let record: AuthSessionRecord | null = null;
  const store: AuthCredentialStore = {
    load: async () => record,
    save: async (next) => {
      record = next;
    },
    clear: async () => {
      record = null;
    },
  };
  return { store, current: () => record };
}

function memoryPendingStore() {
  let pending: PendingAuth | null = null;
  const store: PendingAuthStore = {
    load: async () => pending,
    save: async (next) => {
      pending = next;
    },
    clear: async () => {
      pending = null;
    },
  };
  return { store, current: () => pending };
}

function stateOf(authorizeUrl: string): string {
  return new URL(authorizeUrl).searchParams.get("state") ?? "";
}

describe("AuthService.login", () => {
  it("opens the site authorize page with a PKCE challenge bound to the pending login", async () => {
    const harness = createHarness(() => jsonResponse({}, 500));
    const result = await harness.service.login();

    expect(result).toEqual({ opened: true });
    expect(harness.opened).toHaveLength(1);
    const url = new URL(harness.opened[0]);
    expect(`${url.origin}${url.pathname}`).toBe("https://site.test/zh/desktop/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe("answra://auth/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("device_id")).toBe(DEVICE.id);
    expect(url.searchParams.get("device_name")).toBe(DEVICE.name);
    expect(url.searchParams.get("os")).toBe(DEVICE.os);

    const saved = harness.pending.current();
    expect(saved?.state).toBe(url.searchParams.get("state"));
    expect(saved?.verifier).toBeTruthy();
    expect(pkceChallengeFromVerifier(saved?.verifier ?? "")).toBe(
      url.searchParams.get("code_challenge"),
    );
    // verifier 绝不能出现在授权 URL 里。
    expect(harness.opened[0]).not.toContain(saved?.verifier ?? "no-verifier");
  });

  it("reports a failure and drops the pending login when the browser cannot be opened", async () => {
    const failing = createHarness(() => jsonResponse({}, 500));
    const service = new AuthService({
      endpoints: { apiBaseUrl: "https://api.test", siteBaseUrl: "https://site.test" },
      device: async () => DEVICE,
      credentials: failing.credentials.store,
      pendingStore: failing.pending.store,
      openExternal: async () => {
        throw new Error("no browser");
      },
      callbackChannel: {
        begin: async () => ({ redirectUri: "answra://auth/callback", close: () => undefined }),
      },
      now: () => TEST_NOW,
    });

    await expect(service.login()).resolves.toEqual({ opened: false, error: "no browser" });
    expect(failing.pending.current()).toBeNull();
  });
});

describe("AuthService.handleCallbackUrl", () => {
  it("exchanges the code, stores credentials and pushes the signed-in status", async () => {
    const harness = createHarness((call) => {
      if (call.url.endsWith(AUTH_PATHS.exchange))
        return jsonResponse({ code: 0, message: "ok", data: tokenBody() });
      if (call.url.endsWith(AUTH_PATHS.profile))
        return jsonResponse({
          code: 0,
          message: "ok",
          data: { id: 1, email: "admin@answra.local", username: "admin" },
        });
      if (call.url.endsWith(AUTH_PATHS.quota))
        return jsonResponse({
          code: 0,
          message: "ok",
          data: {
            kind: "subscription",
            plan_name: "Pro",
            expires_at: "2026-12-01T00:00:00Z",
            days_remaining: 42,
            available_credits: 50,
            welfare_credits: 0,
            account_credits: 0,
            periods: [
              {
                name: "monthly",
                used_credits: 30,
                total_credits: 80,
                remaining_credits: 50,
                resets_at: "2026-12-01T00:00:00Z",
              },
            ],
          },
        });
      if (call.url.endsWith(AUTH_PATHS.capabilities)) {
        return jsonResponse({
          code: 0,
          message: "ok",
          data: {
            plan: "pro",
            capabilities: [{ id: "text.chat" }, { id: "voice.interview" }, { noise: true }],
            endpoints: [
              {
                id: "text.chat",
                kind: "text",
                path: "/api/v1/desktop/chat/completions",
                model: "text.chat",
              },
              { id: "voice.interview" },
            ],
          },
        });
      }
      return jsonResponse({}, 404);
    });

    await harness.service.login();
    const state = stateOf(harness.opened[0]);
    const status = await harness.service.handleCallbackUrl(
      `answra://auth/callback?code=code-1&state=${state}`,
    );

    expect(status).toEqual({
      signedIn: true,
      plan: "pro",
      account: { email: "admin@answra.local", username: "admin" },
      quota: {
        kind: "subscription",
        planName: "Pro",
        availableCredits: 50,
        usedCredits: 30,
        totalCredits: 80,
        welfareCredits: 0,
        accountCredits: 0,
        welfareExpiresAt: null,
        usedPercent: 37.5,
        expiresAt: "2026-12-01T00:00:00Z",
        daysRemaining: 42,
      },
      capabilities: ["text.chat", "voice.interview"],
      cloudBaseUrl: "https://api.test",
    });
    expect(harness.statuses.at(-1)).toEqual(status);

    const exchange = harness.calls[0];
    expect(exchange).toMatchObject({
      url: `https://api.test${AUTH_PATHS.exchange}`,
      method: "POST",
    });
    const saved = harness.pending.current();
    expect(exchange.body?.code).toBe("code-1");
    expect(exchange.body?.device).toEqual(DEVICE);
    expect(harness.credentials.current()).toEqual({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: TEST_NOW + 3600_000 - 60_000,
      plan: "pro",
      account: { email: "admin@answra.local", username: "admin" },
      quota: {
        kind: "subscription",
        planName: "Pro",
        availableCredits: 50,
        usedCredits: 30,
        totalCredits: 80,
        welfareCredits: 0,
        accountCredits: 0,
        welfareExpiresAt: null,
        usedPercent: 37.5,
        expiresAt: "2026-12-01T00:00:00Z",
        daysRemaining: 42,
      },
      capabilities: ["text.chat", "voice.interview"],
      // 只有形状完整的端点声明会被保留：客户端据此取调用路径，残缺项直接丢弃。
      endpoints: [
        { id: "text.chat", path: "/api/v1/desktop/chat/completions", model: "text.chat" },
      ],
    });
    expect(saved).toBeNull();
    expect(harness.calls[1]).toMatchObject({
      url: `https://api.test${AUTH_PATHS.capabilities}`,
      authorization: "Bearer access-1",
    });
    expect(harness.calls[2]).toMatchObject({
      url: `https://api.test${AUTH_PATHS.profile}`,
      authorization: "Bearer access-1",
    });
    expect(harness.calls[3]).toMatchObject({
      url: `https://api.test${AUTH_PATHS.quota}`,
      authorization: "Bearer access-1",
    });
  });

  it("verifies the PKCE verifier sent to the gateway matches the generated one", async () => {
    const harness = createHarness(() => jsonResponse(tokenBody()));
    await harness.service.login();
    const state = stateOf(harness.opened[0]);
    const verifier = harness.pending.current()?.verifier ?? "";
    await harness.service.handleCallbackUrl(`answra://auth/callback?code=c&state=${state}`);
    expect(harness.calls[0].body?.code_verifier).toBe(verifier);
  });

  it("still signs in when the capability directory is unavailable", async () => {
    const harness = createHarness((call) =>
      call.url.endsWith(AUTH_PATHS.exchange) ? jsonResponse(tokenBody()) : jsonResponse({}, 500),
    );
    await harness.service.login();
    const state = stateOf(harness.opened[0]);
    const status = await harness.service.handleCallbackUrl(
      `answra://auth/callback?code=c&state=${state}`,
    );
    expect(status).toEqual({
      signedIn: true,
      plan: null,
      account: null,
      quota: null,
      capabilities: [],
      cloudBaseUrl: "https://api.test",
    });
  });

  it("rejects an unknown state without touching the gateway", async () => {
    const harness = createHarness(() => jsonResponse(tokenBody()));
    await harness.service.login();
    await expect(
      harness.service.handleCallbackUrl("answra://auth/callback?code=c&state=forged"),
    ).resolves.toBeNull();
    expect(harness.calls).toHaveLength(0);
    expect(harness.credentials.current()).toBeNull();
  });

  it("rejects a callback that arrives past the 2 minute TTL", async () => {
    let clock = TEST_NOW;
    const harness = createHarness(() => jsonResponse(tokenBody()), { now: () => clock });
    await harness.service.login();
    const state = stateOf(harness.opened[0]);
    clock = TEST_NOW + PENDING_AUTH_TTL_MS + 1;
    await expect(
      harness.service.handleCallbackUrl(`answra://auth/callback?code=c&state=${state}`),
    ).resolves.toBeNull();
    expect(harness.calls).toHaveLength(0);
  });

  it("signs in through the channel-registered callback (loopback/deep-link path)", async () => {
    const harness = createHarness((call) =>
      call.url.endsWith(AUTH_PATHS.exchange)
        ? jsonResponse(tokenBody())
        : jsonResponse({ plan: "free" }),
    );
    await harness.service.login();
    harness.deliverCallbackUrl(`answra://auth/callback?code=c&state=${stateOf(harness.opened[0])}`);
    await vi.waitFor(() => {
      expect(harness.statuses.at(-1)?.signedIn).toBe(true);
    });
  });

  it("ignores a failed exchange and keeps the previous session untouched", async () => {
    const harness = createHarness(() => jsonResponse({}, 401));
    await harness.service.login();
    const state = stateOf(harness.opened[0]);
    await expect(
      harness.service.handleCallbackUrl(`answra://auth/callback?code=c&state=${state}`),
    ).resolves.toBeNull();
    expect(harness.credentials.current()).toBeNull();
    expect(harness.statuses).toHaveLength(0);
  });
});

describe("AuthService.restore / refresh", () => {
  it("uses the gateway's stable desktop auth and capability endpoints", () => {
    expect(AUTH_PATHS).toEqual({
      exchange: "/api/v1/auth/desktop/exchange",
      refresh: "/api/v1/auth/refresh",
      revoke: "/api/v1/auth/logout",
      profile: "/api/v1/auth/me",
      capabilities: "/api/v1/capabilities",
      quota: "/api/v1/user/quota",
      announcements: "/api/v1/announcements",
    });
  });

  it("returns a signed-out status when nothing is stored", async () => {
    const harness = createHarness(() => jsonResponse({}, 500));
    await expect(harness.service.restore()).resolves.toEqual({
      signedIn: false,
      plan: null,
      account: null,
      quota: null,
      capabilities: [],
      cloudBaseUrl: null,
    });
    expect(harness.calls).toHaveLength(0);
  });

  it("refreshes the capability directory for a still-valid saved session", async () => {
    const harness = createHarness(() =>
      jsonResponse({
        code: 0,
        data: { plan: "starter", capabilities: [] },
      }),
    );
    await harness.credentials.store.save({
      accessToken: "access-old",
      refreshToken: "refresh-old",
      expiresAt: TEST_NOW + 60_000,
      plan: "old-plan",
      capabilities: ["text.chat"],
    });
    await expect(harness.service.restore()).resolves.toEqual({
      signedIn: true,
      plan: "starter",
      account: null,
      quota: null,
      capabilities: [],
      cloudBaseUrl: "https://api.test",
    });
    expect(harness.calls).toEqual([
      {
        url: `https://api.test${AUTH_PATHS.capabilities}`,
        method: "GET",
        body: undefined,
        authorization: "Bearer access-old",
      },
      {
        url: `https://api.test${AUTH_PATHS.profile}`,
        method: "GET",
        body: undefined,
        authorization: "Bearer access-old",
      },
      {
        url: `https://api.test${AUTH_PATHS.quota}`,
        method: "GET",
        body: undefined,
        authorization: "Bearer access-old",
      },
    ]);
    expect(harness.credentials.current()).toMatchObject({ plan: "starter", capabilities: [] });
  });

  it("refreshes an expired token and rotates the stored refresh token", async () => {
    const harness = createHarness((call) =>
      call.url.endsWith(AUTH_PATHS.refresh)
        ? jsonResponse(tokenBody("access-new", "refresh-new", 120))
        : jsonResponse({ code: 0, data: { plan: "pro", capabilities: ["text.chat"] } }),
    );
    await harness.credentials.store.save({
      accessToken: "access-old",
      refreshToken: "refresh-old",
      expiresAt: TEST_NOW - 1,
      plan: "pro",
      capabilities: ["text.chat"],
      endpoints: [],
    });

    const status = await harness.service.restore();
    expect(status.signedIn).toBe(true);
    expect(harness.calls).toEqual([
      {
        url: `https://api.test${AUTH_PATHS.refresh}`,
        method: "POST",
        body: { refresh_token: "refresh-old", device: DEVICE },
        authorization: undefined,
      },
      {
        url: `https://api.test${AUTH_PATHS.capabilities}`,
        method: "GET",
        body: undefined,
        authorization: "Bearer access-new",
      },
      {
        url: `https://api.test${AUTH_PATHS.profile}`,
        method: "GET",
        body: undefined,
        authorization: "Bearer access-new",
      },
      {
        url: `https://api.test${AUTH_PATHS.quota}`,
        method: "GET",
        body: undefined,
        authorization: "Bearer access-new",
      },
    ]);
    expect(harness.credentials.current()).toEqual({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      expiresAt: TEST_NOW + 120_000 - 60_000,
      plan: "pro",
      account: null,
      quota: null,
      capabilities: ["text.chat"],
      endpoints: [],
    });
  });

  it("drops the session when the refresh is rejected", async () => {
    const harness = createHarness(() => jsonResponse({}, 401));
    await harness.credentials.store.save({
      accessToken: "access-old",
      refreshToken: "refresh-old",
      expiresAt: TEST_NOW - 1,
      plan: "pro",
      capabilities: ["text.chat"],
      endpoints: [],
    });

    await expect(harness.service.restore()).resolves.toEqual({
      signedIn: false,
      plan: null,
      account: null,
      quota: null,
      capabilities: [],
      cloudBaseUrl: null,
    });
    expect(harness.credentials.current()).toBeNull();
  });

  it("refreshes only once for concurrent status queries", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = createHarness(async (call) => {
      if (call.url.endsWith(AUTH_PATHS.refresh)) await gate;
      if (call.url.endsWith(AUTH_PATHS.refresh))
        return jsonResponse(tokenBody("access-new", "refresh-new"));
      return jsonResponse({ code: 0, data: { plan: null, capabilities: [] } });
    });
    await harness.credentials.store.save({
      accessToken: "access-old",
      refreshToken: "refresh-old",
      expiresAt: TEST_NOW - 1,
      plan: null,
      capabilities: [],
    });

    const restoring = harness.service.restore();
    await vi.waitFor(() => expect(harness.calls).toHaveLength(1));
    const racing = harness.service.getStatus();
    release?.();
    const [restored, raced] = await Promise.all([restoring, racing]);
    expect(restored.signedIn).toBe(true);
    expect(raced.signedIn).toBe(true);
    // 一次刷新 + 能力目录 + 账号信息 + 套餐额度，各一次。
    expect(harness.calls).toHaveLength(4);
  });
});

describe("AuthService.refresh failure classification", () => {
  const expiredSession: AuthSessionRecord = {
    accessToken: "access-old",
    refreshToken: "refresh-old",
    expiresAt: TEST_NOW - 1,
    plan: "pro",
    capabilities: ["text.chat"],
  };
  const refreshCalls = (calls: { url: string }[]) =>
    calls.filter((call) => call.url.endsWith(AUTH_PATHS.refresh));

  it("keeps the stored session when the refresh cannot reach the gateway", async () => {
    const harness = createHarness((call) => {
      if (call.url.endsWith(AUTH_PATHS.refresh)) throw new TypeError("fetch failed");
      return jsonResponse({ code: 0, data: { plan: "pro", capabilities: ["text.chat"] } });
    });
    await harness.credentials.store.save(expiredSession);

    await expect(harness.service.restore()).resolves.toEqual({
      signedIn: true,
      plan: "pro",
      account: null,
      quota: null,
      capabilities: ["text.chat"],
      cloudBaseUrl: "https://api.test",
    });
    // 离线启动不得清掉 refresh token：否则用户只要断网启动一次就要重走浏览器登录。
    expect(harness.credentials.current()).toMatchObject({ refreshToken: "refresh-old" });
    expect(harness.statuses).toEqual([]);
  });

  it("keeps the stored session for transient gateway statuses", async () => {
    for (const status of [500, 502, 503, 408, 429]) {
      const harness = createHarness(() => jsonResponse({}, status));
      await harness.credentials.store.save(expiredSession);

      const status_ = await harness.service.restore();
      expect(status_.signedIn, `HTTP ${status}`).toBe(true);
      expect(harness.credentials.current(), `HTTP ${status}`).toMatchObject({
        refreshToken: "refresh-old",
      });
      expect(harness.statuses, `HTTP ${status}`).toEqual([]);
    }
  });

  it("drops the session only when the server rejects the refresh token", async () => {
    for (const status of [400, 401, 403]) {
      const harness = createHarness(() => jsonResponse({}, status));
      await harness.credentials.store.save(expiredSession);

      await expect(harness.service.restore()).resolves.toEqual({
        signedIn: false,
        plan: null,
        account: null,
        quota: null,
        capabilities: [],
        cloudBaseUrl: null,
      });
      expect(harness.credentials.current(), `HTTP ${status}`).toBeNull();
      expect(harness.statuses.at(-1)?.signedIn, `HTTP ${status}`).toBe(false);
    }
  });

  it("stops retrying within the cooldown and retries once it expires", async () => {
    let now = TEST_NOW;
    let remainingFailures = 1;
    const harness = createHarness(
      (call) => {
        if (call.url.endsWith(AUTH_PATHS.refresh)) {
          if (remainingFailures > 0) {
            remainingFailures -= 1;
            throw new TypeError("fetch failed");
          }
          return jsonResponse(tokenBody("access-new", "refresh-new"));
        }
        return jsonResponse({ code: 0, data: { plan: "pro", capabilities: ["text.chat"] } });
      },
      { now: () => now },
    );
    await harness.credentials.store.save(expiredSession);

    await harness.service.restore();
    expect(refreshCalls(harness.calls)).toHaveLength(1);

    // 冷却期内不再发刷新请求，直接返回缓存登录态（避免离线时每次查询都等一次超时）。
    now += 30_000;
    await expect(harness.service.getStatus()).resolves.toMatchObject({ signedIn: true });
    expect(refreshCalls(harness.calls)).toHaveLength(1);

    now += 60_000;
    await expect(harness.service.getStatus()).resolves.toMatchObject({ signedIn: true });
    expect(refreshCalls(harness.calls)).toHaveLength(2);
    expect(harness.credentials.current()).toMatchObject({
      accessToken: "access-new",
      refreshToken: "refresh-new",
    });
  });
});

describe("AuthService.hasSession", () => {
  it("treats an unfinished restore as signed in so a cold start never blocks a logged-in user", () => {
    const harness = createHarness(() => jsonResponse({}, 500));

    expect(harness.service.hasSession()).toBe(true);
  });

  it("reports the local session without touching the gateway", async () => {
    const harness = createHarness(() => jsonResponse({}, 500));
    await harness.service.restore();
    expect(harness.service.hasSession()).toBe(false);

    await harness.credentials.store.save({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: TEST_NOW + 60_000,
      plan: null,
      capabilities: [],
    });
    await harness.service.restore();

    expect(harness.service.hasSession()).toBe(true);
  });
});

describe("AuthService.logout", () => {
  it("revokes the refresh token, clears credentials and pushes a signed-out status", async () => {
    const harness = createHarness((call) =>
      call.url.endsWith(AUTH_PATHS.exchange) ? jsonResponse(tokenBody()) : jsonResponse({}, 204),
    );
    await harness.credentials.store.save({
      accessToken: "access-old",
      refreshToken: "refresh-old",
      expiresAt: TEST_NOW + 60_000,
      plan: "pro",
      capabilities: ["text.chat"],
    });
    await harness.service.restore();

    await expect(harness.service.logout()).resolves.toEqual({
      signedIn: false,
      plan: null,
      account: null,
      quota: null,
      capabilities: [],
      cloudBaseUrl: null,
    });
    expect(harness.calls.at(-1)).toMatchObject({
      url: `https://api.test${AUTH_PATHS.revoke}`,
      method: "POST",
      body: { refresh_token: "refresh-old", device: DEVICE },
    });
    expect(harness.credentials.current()).toBeNull();
    expect(harness.statuses.at(-1)?.signedIn).toBe(false);
  });

  it("stays signed out locally even when the revoke call fails", async () => {
    const harness = createHarness(() => jsonResponse({}, 500));
    await harness.credentials.store.save({
      accessToken: "access-old",
      refreshToken: "refresh-old",
      expiresAt: TEST_NOW + 60_000,
      plan: null,
      capabilities: [],
    });
    await harness.service.restore();
    await expect(harness.service.logout()).resolves.toMatchObject({ signedIn: false });
    expect(harness.credentials.current()).toBeNull();
  });
});

describe("readTokens", () => {
  it("converts expires_in seconds into an absolute expiry with a safety margin", () => {
    expect(readTokens(tokenBody("a", "r", 600), TEST_NOW)).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: TEST_NOW + 600_000 - 60_000,
    });
  });

  it("accepts the non-device token spellings as a fallback", () => {
    expect(
      readTokens({ access_token: "a", refresh_token: "r", expires_in: 60 }, TEST_NOW),
    ).toMatchObject({ accessToken: "a", refreshToken: "r" });
  });

  it("falls back to a conservative lifetime when expires_in is missing", () => {
    // 兜底值只影响刷新频率，不决定登录态寿命；不能小到变成频繁刷新。
    expect(readTokens({ device_access_token: "a", device_refresh_token: "r" }, TEST_NOW)).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: TEST_NOW + 3600_000 - 60_000,
    });
  });

  it("throws when the gateway omits a token", () => {
    expect(() => readTokens({ device_access_token: "a" }, TEST_NOW)).toThrow(/refresh token/);
    expect(() => readTokens({}, TEST_NOW)).toThrow(/access token/);
  });
});

describe("readProfile", () => {
  it("accepts string and object capability entries and keeps well-formed endpoints", () => {
    expect(
      readProfile({
        plan: "pro",
        capabilities: ["a", { id: "b" }],
        endpoints: [{ id: "a", path: "/api/v1/desktop/chat/completions", model: "a" }, { id: "b" }],
      }),
    ).toEqual({
      plan: "pro",
      capabilities: ["a", "b"],
      endpoints: [{ id: "a", path: "/api/v1/desktop/chat/completions", model: "a" }],
    });
  });

  it("defaults to an empty capability set, null plan and no endpoints", () => {
    expect(readProfile(undefined)).toEqual({ plan: null, capabilities: [], endpoints: [] });
    expect(readProfile({ capabilities: "nope" })).toEqual({
      plan: null,
      capabilities: [],
      endpoints: [],
    });
  });
});

describe("readAccount", () => {
  it("keeps email and username independently", () => {
    expect(readAccount({ email: "a@b.c", username: "admin" })).toEqual({
      email: "a@b.c",
      username: "admin",
    });
    expect(readAccount({ username: "admin" })).toEqual({ email: null, username: "admin" });
    expect(readAccount({ email: "a@b.c" })).toEqual({ email: "a@b.c", username: null });
  });

  it("returns null when the profile has no displayable identity", () => {
    expect(readAccount(null)).toBeNull();
    expect(readAccount({})).toBeNull();
    expect(readAccount({ email: "", username: "" })).toBeNull();
  });
});

describe("readQuota", () => {
  it("reads subscription credits from the server summary", () => {
    expect(
      readQuota({
        kind: "subscription",
        plan_name: "标准版",
        available_credits: 50,
        welfare_credits: 0,
        account_credits: 0,
        expires_at: "2026-12-01T00:00:00Z",
        days_remaining: 42,
        periods: [{ name: "monthly", used_credits: 30, total_credits: 80, remaining_credits: 50 }],
      }),
    ).toEqual({
      kind: "subscription",
      planName: "标准版",
      availableCredits: 50,
      usedCredits: 30,
      totalCredits: 80,
      welfareCredits: 0,
      accountCredits: 0,
      welfareExpiresAt: null,
      usedPercent: 37.5,
      expiresAt: "2026-12-01T00:00:00Z",
      daysRemaining: 42,
    });
  });

  it("reads free quota and its welfare source without a subscription meter", () => {
    expect(
      readQuota({
        kind: "default",
        plan_name: "免费版",
        available_credits: 20,
        welfare_credits: 12,
        account_credits: 8,
        welfare_expires_at: "2026-11-01T00:00:00Z",
        periods: [],
      }),
    ).toEqual({
      kind: "default",
      planName: "免费版",
      availableCredits: 20,
      usedCredits: null,
      totalCredits: null,
      welfareCredits: 12,
      accountCredits: 8,
      welfareExpiresAt: "2026-11-01T00:00:00Z",
      usedPercent: null,
      expiresAt: null,
      daysRemaining: null,
    });
  });

  it("returns null for empty or unrecognised payloads", () => {
    expect(readQuota(undefined)).toBeNull();
    expect(readQuota({})).toBeNull();
    expect(readQuota([])).toBeNull();
    expect(readQuota({ plan_name: "标准版" })).toBeNull();
  });
});

describe("AuthService announcements", () => {
  it("lists the signed-in user's visible announcements with the main-owned access token", async () => {
    const harness = createHarness(() =>
      jsonResponse({
        code: 0,
        data: [
          {
            id: 7,
            title: "版本更新",
            content: "新增公告中心",
            notify_mode: "popup",
            read_at: null,
            created_at: "2026-10-17T10:00:00Z",
          },
        ],
      }),
    );
    await harness.credentials.store.save({
      accessToken: "private-access",
      refreshToken: "private-refresh",
      expiresAt: TEST_NOW + 120_000,
      plan: "pro",
      capabilities: [],
    });
    await harness.service.restore();

    await expect(harness.service.listAnnouncements()).resolves.toEqual([
      {
        id: 7,
        title: "版本更新",
        content: "新增公告中心",
        notifyMode: "popup",
        readAt: null,
        createdAt: "2026-10-17T10:00:00Z",
      },
    ]);
    expect(
      harness.calls.find((call) => call.url === "https://api.test/api/v1/announcements"),
    ).toMatchObject({
      authorization: "Bearer private-access",
    });
  });

  it("marks visible announcements read without exposing the token to the renderer contract", async () => {
    const harness = createHarness(() => jsonResponse({ code: 0, data: { message: "ok" } }));
    await harness.credentials.store.save({
      accessToken: "private-access",
      refreshToken: "private-refresh",
      expiresAt: TEST_NOW + 120_000,
      plan: null,
      capabilities: [],
    });
    await harness.service.restore();

    await harness.service.markAnnouncementRead(7);
    expect(
      harness.calls.find((call) => call.url === "https://api.test/api/v1/announcements/7/read"),
    ).toMatchObject({
      method: "POST",
      authorization: "Bearer private-access",
      body: {},
    });
    await expect(harness.service.markAnnouncementRead(0)).rejects.toThrow("公告 ID 无效");
  });

  it("returns no announcements when signed out and rejects malformed list entries", async () => {
    const harness = createHarness(() => jsonResponse({ code: 0, data: [] }));
    await expect(harness.service.listAnnouncements()).resolves.toEqual([]);
    expect(harness.calls).toHaveLength(0);
    expect(
      readAnnouncements([null, { id: "bad" }, { id: 2, title: "ok", content: "body" }]),
    ).toEqual([
      { id: 2, title: "ok", content: "body", notifyMode: "silent", readAt: null, createdAt: "" },
    ]);
  });
});

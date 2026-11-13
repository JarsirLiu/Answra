import { describe, expect, it } from "vitest";
import {
  parseAuthorizationCodeInput,
  RemoteAuthService,
} from "../../../src/remote/auth/remoteAuthService";
import type {
  ServiceAuthRecord,
  ServiceAuthStore,
} from "../../../src/remote/auth/serviceAuthStore";

const NOW = 1_800_000_000_000;

function createStore(): ServiceAuthStore & { current(): ServiceAuthRecord | null } {
  let record: ServiceAuthRecord | null = null;
  return {
    read: async () => record,
    write: async (next) => {
      record = next;
    },
    clear: async () => {
      record = null;
    },
    current: () => record,
  };
}

describe("RemoteAuthService", () => {
  it("uses configured site and API base URLs for local development", async () => {
    const store = createStore();
    const requests: Array<{ url: string; method: string }> = [];
    let authorizeUrl = "";
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push({ url, method: init?.method ?? "GET" });
      if (url.endsWith("/api/v1/auth/desktop/exchange")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              device_access_token: "access-token",
              device_refresh_token: "refresh-token",
              expires_in: 3600,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/api/v1/auth/me")) {
        return new Response(JSON.stringify({ code: 0, data: { email: "dev@example.com" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const service = new RemoteAuthService({
      store,
      device: async () => ({ id: "device-1", name: "devbox", os: "win32" }),
      promptCode: async () => {
        const state = new URL(authorizeUrl).searchParams.get("state");
        if (state === null) throw new Error("state missing");
        return `code-1#${state}`;
      },
      siteBaseUrl: "http://127.0.0.1:3100",
      apiBaseUrl: "http://127.0.0.1:8080",
      fetch: fetchImpl,
      now: () => NOW,
    });

    await service.login({
      onAuthorizeUrl: (url) => {
        authorizeUrl = url;
      },
    });

    const page = new URL(authorizeUrl);
    expect(page.origin).toBe("http://127.0.0.1:3100");
    expect(page.pathname).toBe("/zh/cli/authorize");
    expect(page.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:3100/zh/cli/authorize/callback",
    );
    expect(page.searchParams.get("code_challenge_method")).toBe("S256");
    expect(requests).toEqual([
      { url: "http://127.0.0.1:8080/api/v1/auth/desktop/exchange", method: "POST" },
      { url: "http://127.0.0.1:8080/api/v1/auth/me", method: "GET" },
    ]);
    expect(store.current()).toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      account: "dev@example.com",
    });
  });

  it("parses pasted callback URLs and rejects state mismatches", () => {
    expect(
      parseAuthorizationCodeInput(
        "http://127.0.0.1:3100/zh/cli/authorize/callback?code=abc&state=xyz",
        "xyz",
      ),
    ).toEqual({ code: "abc", state: "xyz" });
    expect(() => parseAuthorizationCodeInput("abc#other", "xyz")).toThrow("state 不匹配");
    expect(() => parseAuthorizationCodeInput("abc", "xyz")).toThrow("授权码格式无效");
  });
});

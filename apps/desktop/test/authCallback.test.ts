import { describe, expect, it } from "vitest";
import {
  findAuthCallbackUrl,
  isAuthCallbackTarget,
  normalizeCallbackTarget,
  parseAuthCallback,
} from "../src/main/auth/callback";

/** 授权回跳解析：只接受本应用的回调目标，其余一律拒绝。 */
describe("parseAuthCallback", () => {
  it("accepts the packaged deep link", () => {
    expect(parseAuthCallback("answra://auth/callback?code=abc123&state=xyz")).toEqual({
      ok: true,
      code: "abc123",
      state: "xyz",
      target: "answra://auth/callback",
    });
  });

  it("accepts the dev loopback callback", () => {
    const result = parseAuthCallback("http://127.0.0.1:51234/auth/callback?code=c&state=s");
    expect(result).toEqual({
      ok: true,
      code: "c",
      state: "s",
      target: "http://127.0.0.1:51234/auth/callback",
    });
  });

  it("normalizes target casing", () => {
    expect(parseAuthCallback("ANSWRA://Auth/Callback?code=c&state=s")).toEqual({
      ok: true,
      code: "c",
      state: "s",
      target: "answra://auth/callback",
    });
  });

  it("reports a denied authorization with the server description", () => {
    const result = parseAuthCallback(
      "answra://auth/callback?error=access_denied&error_description=user%20cancelled",
    );
    expect(result).toEqual({ ok: false, reason: "denied", message: "user cancelled" });
  });

  it("rejects callbacks missing code or state", () => {
    expect(parseAuthCallback("answra://auth/callback?state=s")).toEqual({
      ok: false,
      reason: "missing-params",
    });
    expect(parseAuthCallback("answra://auth/callback?code=c")).toEqual({
      ok: false,
      reason: "missing-params",
    });
  });

  it("rejects other schemes, hosts and paths", () => {
    for (const url of [
      "answra://other/callback?code=c&state=s",
      "answra://auth/other?code=c&state=s",
      "https://evil.example/auth/callback?code=c&state=s",
      "http://192.168.1.5:51234/auth/callback?code=c&state=s",
    ]) {
      expect(parseAuthCallback(url).ok).toBe(false);
    }
  });

  it("rejects non-URL input", () => {
    expect(parseAuthCallback("not a url")).toEqual({ ok: false, reason: "invalid-url" });
    expect(parseAuthCallback("")).toEqual({ ok: false, reason: "invalid-url" });
  });
});

describe("isAuthCallbackTarget", () => {
  it("allows only the deep link and loopback callback", () => {
    expect(isAuthCallbackTarget("answra://auth/callback")).toBe(true);
    expect(isAuthCallbackTarget("http://127.0.0.1:80/auth/callback")).toBe(true);
    expect(isAuthCallbackTarget("http://localhost:80/auth/callback")).toBe(false);
    expect(isAuthCallbackTarget("answra://auth/callback/extra")).toBe(false);
  });
});

describe("normalizeCallbackTarget", () => {
  it("drops query and hash", () => {
    expect(normalizeCallbackTarget("answra://auth/callback?code=c#frag")).toBe(
      "answra://auth/callback",
    );
    expect(normalizeCallbackTarget("nonsense")).toBeNull();
  });
});

describe("findAuthCallbackUrl", () => {
  it("finds the deep link among other argv entries", () => {
    expect(
      findAuthCallbackUrl(["--flag", "answra://auth/callback?code=c&state=s", "--other"]),
    ).toBe("answra://auth/callback?code=c&state=s");
  });

  it("returns null when argv carries no callback", () => {
    expect(findAuthCallbackUrl(["/path/to/electron", "."])).toBeNull();
  });
});

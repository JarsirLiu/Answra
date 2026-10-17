import { describe, expect, it } from "vitest";
import {
  base64Url,
  createAuthState,
  createCodeVerifier,
  createPkceChallenge,
  pkceChallengeFromVerifier,
} from "../src/main/auth/pkce";

/** PKCE 生成器：S256 必须与 RFC 7636 附录 B 的官方测试向量一致。 */
describe("pkceChallengeFromVerifier", () => {
  it("matches the RFC 7636 appendix B vector", () => {
    expect(pkceChallengeFromVerifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("createCodeVerifier", () => {
  it("emits a base64url string without padding", () => {
    const verifier = createCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(verifier).toHaveLength(43);
  });

  it("does not repeat across calls", () => {
    expect(createCodeVerifier()).not.toBe(createCodeVerifier());
  });
});

describe("createAuthState", () => {
  it("is base64url and unique per call", () => {
    const state = createAuthState();
    expect(state).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(state).not.toBe(createAuthState());
  });
});

describe("createPkceChallenge", () => {
  it("derives the challenge from the emitted verifier", () => {
    const { verifier, challenge } = createPkceChallenge();
    expect(challenge).toBe(pkceChallengeFromVerifier(verifier));
    expect(challenge).not.toBe(verifier);
  });
});

describe("base64Url", () => {
  it("strips padding and swaps url-unsafe characters", () => {
    // 0xfb 0xff 0xbf 的 base64 为 "+/+/"，必须被替换成 "-_-_"。
    expect(base64Url(Buffer.from([0xfb, 0xff, 0xbf]))).toBe("-_-_");
    expect(base64Url(Buffer.from("a"))).toBe("YQ");
  });
});

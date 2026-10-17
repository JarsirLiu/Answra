import { createHash, randomBytes } from "node:crypto";

/**
 * PKCE（RFC 7636）与 `state` 生成。
 *
 * 授权码流必须带 S256 challenge：桌面端是公共客户端，无法安全保存 client secret，
 * 用一次性 `code_verifier` 把授权码绑定到本次登录尝试。
 */

const VERIFIER_BYTES = 32;
const STATE_BYTES = 24;

export interface PkceChallenge {
  verifier: string;
  challenge: string;
}

/** 无填充 base64url（PKCE 与 state 的 RFC 允许字符集）。 */
export function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))`（RFC 7636 §4.2）。 */
export function pkceChallengeFromVerifier(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier, "ascii").digest());
}

export function createCodeVerifier(): string {
  return base64Url(randomBytes(VERIFIER_BYTES));
}

/** 防 CSRF 的一次性随机串；回跳时必须原样带回并命中待处理登录。 */
export function createAuthState(): string {
  return base64Url(randomBytes(STATE_BYTES));
}

export function createPkceChallenge(): PkceChallenge {
  const verifier = createCodeVerifier();
  return { verifier, challenge: pkceChallengeFromVerifier(verifier) };
}

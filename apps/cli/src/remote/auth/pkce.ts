/** CLI 公共客户端的 PKCE S256 与一次性 state；不保存 verifier 到磁盘。 */
import { createHash, randomBytes } from "node:crypto";

const VERIFIER_BYTES = 32;
const STATE_BYTES = 24;

export interface PkceChallenge {
  verifier: string;
  challenge: string;
}

/** RFC 7636 无填充 base64url。 */
export function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createPkceChallenge(): PkceChallenge {
  const verifier = base64Url(randomBytes(VERIFIER_BYTES));
  return {
    verifier,
    challenge: base64Url(createHash("sha256").update(verifier, "ascii").digest()),
  };
}

export function createAuthState(): string {
  return base64Url(randomBytes(STATE_BYTES));
}

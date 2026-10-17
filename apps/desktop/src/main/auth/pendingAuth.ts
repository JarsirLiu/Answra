/**
 * 待处理登录（一次性 `state` + `code_verifier`）。
 *
 * 约束：
 * - 同时只允许一个待处理登录；再次发起登录会作废上一次（旧 `state` 回跳一律拒绝）。
 * - `state` 单次使用：命中后立即消费，重放同一回调无效。
 * - `state` 有 2 分钟 TTL，过期回调拒绝（防长时间挂起的标签页被劫持后回放）。
 * - `redirect_uri` 必须与发起时一致；登出会清空待处理登录（旧回调随即失效）。
 */
import { normalizeCallbackTarget } from "./callback";

export const PENDING_AUTH_TTL_MS = 2 * 60 * 1000;

export interface PendingAuth {
  state: string;
  verifier: string;
  redirectUri: string;
  createdAt: number;
}

export type PendingConsumeFailure =
  | "no-pending"
  | "unknown-state"
  | "expired"
  | "redirect-mismatch";

export type PendingConsumeResult =
  | { ok: true; pending: PendingAuth }
  | { ok: false; reason: PendingConsumeFailure };

export class PendingAuthRegistry {
  private pending: PendingAuth | null = null;

  constructor(private readonly ttlMs: number = PENDING_AUTH_TTL_MS) {}

  /** 记录新一次登录尝试，作废上一次（并返回被作废的那个，便于调用方关闭其回调通道）。 */
  create(
    input: { state: string; verifier: string; redirectUri: string },
    now = Date.now(),
  ): {
    pending: PendingAuth;
    replaced: PendingAuth | null;
  } {
    const replaced = this.pending;
    const pending: PendingAuth = {
      state: input.state,
      verifier: input.verifier,
      redirectUri: input.redirectUri,
      createdAt: now,
    };
    this.pending = pending;
    return { pending, replaced };
  }

  /** 校验并消费；任何失败路径都会清空当前待处理登录。 */
  consume(input: { state: string; target: string }, now = Date.now()): PendingConsumeResult {
    const pending = this.pending;
    if (!pending) return { ok: false, reason: "no-pending" };
    this.pending = null;
    if (input.state !== pending.state) return { ok: false, reason: "unknown-state" };
    if (now - pending.createdAt > this.ttlMs) return { ok: false, reason: "expired" };
    if (normalizeCallbackTarget(pending.redirectUri) !== input.target) {
      return { ok: false, reason: "redirect-mismatch" };
    }
    return { ok: true, pending };
  }

  clear(): void {
    this.pending = null;
  }

  /** 启动时载入持久化的待处理登录（冷启动深链回跳的唯一依据）。 */
  restore(pending: PendingAuth | null): void {
    this.pending = pending;
  }

  hasPending(): boolean {
    return this.pending !== null;
  }
}

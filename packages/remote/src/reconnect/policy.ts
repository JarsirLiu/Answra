/** 远程重连退避与预算；只计算延迟/耗尽，不创建 socket、peer 或 UI 状态。 */

/** 首次重连等待 1 秒，之后指数递增，最多 30 秒。 */
export const REMOTE_RECONNECT_BASE_DELAYS_MS = [
  1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
] as const;

/** 每个退避档位允许 ±20% 抖动，避免多个客户端同时重连。 */
export const REMOTE_RECONNECT_JITTER_RATIO = 0.2;

/** 从第一次失败到放弃的总预算。 */
export const REMOTE_RECONNECT_MAX_ELAPSED_MS = 120_000;

/** L2 重建最多尝试 3 次，达到后进入 remote-unreachable。 */
export const REMOTE_RECONNECT_MAX_ATTEMPTS = 3;

export type RemoteReconnectDecision =
  | { readonly kind: "retry"; readonly attempt: number; readonly delayMs: number }
  | { readonly kind: "exhausted"; readonly attempts: number; readonly elapsedMs: number };

export interface RemoteReconnectPolicyOptions {
  now?: () => number;
  random?: () => number;
  baseDelaysMs?: readonly number[];
  jitterRatio?: number;
  maxElapsedMs?: number;
  maxAttempts?: number;
}

/**
 * 单次断线恢复的预算。调用方在连接恢复时 reset；这里不保存连接状态。
 * attempt 从 1 开始，表示即将进行的第几次重建。
 */
export class RemoteReconnectPolicy {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly baseDelaysMs: readonly number[];
  private readonly jitterRatio: number;
  private readonly maxElapsedMs: number;
  private readonly maxAttempts: number;
  private startedAt?: number;
  private attempts = 0;

  constructor({
    now = () => Date.now(),
    random = () => Math.random(),
    baseDelaysMs = REMOTE_RECONNECT_BASE_DELAYS_MS,
    jitterRatio = REMOTE_RECONNECT_JITTER_RATIO,
    maxElapsedMs = REMOTE_RECONNECT_MAX_ELAPSED_MS,
    maxAttempts = REMOTE_RECONNECT_MAX_ATTEMPTS,
  }: RemoteReconnectPolicyOptions = {}) {
    if (baseDelaysMs.length === 0) throw new Error("reconnect base delays must not be empty");
    this.now = now;
    this.random = random;
    this.baseDelaysMs = baseDelaysMs;
    this.jitterRatio = jitterRatio;
    this.maxElapsedMs = maxElapsedMs;
    this.maxAttempts = maxAttempts;
  }

  start(): void {
    if (this.startedAt === undefined) this.startedAt = this.now();
  }

  reset(): void {
    this.startedAt = undefined;
    this.attempts = 0;
  }

  attemptsMade(): number {
    return this.attempts;
  }

  elapsedMs(): number {
    if (this.startedAt === undefined) return 0;
    return Math.max(0, this.now() - this.startedAt);
  }

  /** 返回下一次重建决定；调用即消耗一次尝试。 */
  next(): RemoteReconnectDecision {
    this.start();
    const elapsedMs = this.elapsedMs();
    if (this.attempts >= this.maxAttempts || elapsedMs >= this.maxElapsedMs) {
      return { kind: "exhausted", attempts: this.attempts, elapsedMs };
    }

    this.attempts += 1;
    const baseDelay =
      this.baseDelaysMs[Math.min(this.attempts - 1, this.baseDelaysMs.length - 1)] ??
      this.baseDelaysMs[this.baseDelaysMs.length - 1];
    if (baseDelay === undefined) {
      throw new Error("reconnect base delay is missing");
    }
    const jitter = 1 + (this.random() * 2 - 1) * this.jitterRatio;
    return {
      kind: "retry",
      attempt: this.attempts,
      delayMs: Math.max(1, Math.round(baseDelay * jitter)),
    };
  }
}

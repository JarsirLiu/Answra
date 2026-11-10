import {
  AGENT_CONNECTION_TARGET,
  type AgentConnectionReason,
  type AgentConnectionState,
  agentServiceDisconnectedError,
} from "@answra/shared";

/** Worker 宿主退出信号；只保留跨平台字段。 */
export interface AgentWorkerExit {
  code: number | null;
  signal?: string;
}

/**
 * 平台无关的 worker 宿主端口。Electron utility process、CLI 的 child_process
 * 或测试假实现都实现它；连接状态机不依赖任何平台 API。
 */
export interface AgentWorkerHost {
  /** 创建 worker 并完成就绪探测；失败时抛出 `AgentWorkerStartError`。 */
  start: () => Promise<void>;
  /** 主动停止当前 worker；用于重启或应用退出。 */
  stop: () => Promise<void>;
  /** 订阅非主动退出；返回取消订阅函数。 */
  onExit: (listener: (exit: AgentWorkerExit) => void) => () => void;
}

/** 客户端只依赖这三件事，桌面 IPC、CLI 输出各自适配。 */
export interface AgentConnectionClient {
  getState: () => AgentConnectionState;
  subscribe: (listener: (state: AgentConnectionState) => void) => () => void;
  ensureStarted: () => Promise<void>;
}

/** 宿主用稳定原因报告启动失败，连接状态机负责重试与状态迁移。 */
export class AgentWorkerStartError extends Error {
  constructor(
    readonly reason: AgentConnectionReason,
    message: string,
  ) {
    super(message);
    this.name = "AgentWorkerStartError";
  }
}

export interface AgentConnectionPolicy {
  /** 一轮最多尝试次数；状态里同时下发给客户端。 */
  maxAttempts: number;
  /** 第 n 次失败后的等待时间；长度不足时复用最后一项。 */
  retryDelaysMs: readonly number[];
}

export const DEFAULT_AGENT_CONNECTION_POLICY: AgentConnectionPolicy = {
  maxAttempts: 5,
  retryDelaysMs: [1_000, 2_000, 4_000, 8_000],
};

type ConnectionStateInput =
  | { status: "connecting"; attempt: number; maxAttempts: number }
  | {
      status: "connected";
      attempt: number;
      maxAttempts: number;
      connectedAt: number;
    }
  | {
      status: "reconnecting";
      attempt: number;
      maxAttempts: number;
      nextRetryAt: number;
      reason: AgentConnectionReason;
      detail?: string;
    }
  | {
      status: "unavailable";
      attempt: number;
      maxAttempts: number;
      reason: AgentConnectionReason;
      detail?: string;
    };

interface AgentConnectionSupervisorOptions {
  policy?: Partial<AgentConnectionPolicy>;
  now?: () => number;
}

/**
 * Agent worker 连接状态机。唯一 writer；平台层只提供 worker host 和状态出口。
 *
 * 一次 episode：`connecting` →（失败退避）`reconnecting` → `connected` 或
 * `unavailable`。`unavailable` 不自动循环；下一次 `ensureStarted` 开启新 episode。
 * worker 在 `connected` 时退出会自动开启一次 `reconnecting` episode。
 */
export class AgentConnectionSupervisor implements AgentConnectionClient {
  private readonly listeners = new Set<(state: AgentConnectionState) => void>();
  private readonly policy: AgentConnectionPolicy;
  private readonly now: () => number;
  private readonly unsubscribeExit: () => void;
  private state: AgentConnectionState;
  private revision = 0;
  private startPromise?: Promise<void>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryWake?: () => void;
  private disposed = false;

  constructor(
    private readonly host: AgentWorkerHost,
    options: AgentConnectionSupervisorOptions = {},
  ) {
    this.policy = {
      maxAttempts: options.policy?.maxAttempts ?? DEFAULT_AGENT_CONNECTION_POLICY.maxAttempts,
      retryDelaysMs: options.policy?.retryDelaysMs ?? DEFAULT_AGENT_CONNECTION_POLICY.retryDelaysMs,
    };
    if (this.policy.maxAttempts < 1) throw new Error("连接重试次数必须大于 0");
    if (this.policy.retryDelaysMs.length === 0) throw new Error("连接重试退避不能为空");
    this.now = options.now ?? (() => Date.now());
    this.state = {
      target: AGENT_CONNECTION_TARGET,
      revision: 0,
      updatedAt: this.now(),
      status: "connecting",
      attempt: 1,
      maxAttempts: this.policy.maxAttempts,
    };
    this.unsubscribeExit = this.host.onExit((exit) => this.handleExit(exit));
  }

  getState(): AgentConnectionState {
    return this.state;
  }

  /** 订阅时立即推送当前状态，避免调用方先 get 再 subscribe 丢中间变更。 */
  subscribe(listener: (state: AgentConnectionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async ensureStarted(): Promise<void> {
    if (this.disposed) throw agentServiceDisconnectedError("连接管理器已关闭");
    if (this.state.status === "connected") return;
    if (this.startPromise) return this.startPromise;
    const promise = this.startEpisode("initial").finally(() => {
      if (this.startPromise === promise) this.startPromise = undefined;
    });
    this.startPromise = promise;
    return promise;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeExit();
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.retryWake?.();
    this.retryWake = undefined;
    this.listeners.clear();
    await this.host.stop();
  }

  private handleExit(exit: AgentWorkerExit): void {
    if (this.disposed) return;
    if (this.state.status !== "connected" || this.startPromise) return;
    const detail = exit.code === null ? "worker exited" : `worker exited (${exit.code})`;
    const promise = this.startEpisode("reconnect", detail).finally(() => {
      if (this.startPromise === promise) this.startPromise = undefined;
    });
    this.startPromise = promise;
    void promise.catch(() => undefined);
  }

  private async startEpisode(
    mode: "initial" | "reconnect",
    reconnectDetail?: string,
  ): Promise<void> {
    let lastFailure: { reason: AgentConnectionReason; detail: string } | undefined;
    for (let attempt = 1; attempt <= this.policy.maxAttempts; attempt += 1) {
      if (this.disposed) throw agentServiceDisconnectedError("连接管理器已关闭");
      if (attempt === 1) {
        this.emit(
          mode === "reconnect"
            ? {
                status: "reconnecting",
                attempt,
                maxAttempts: this.policy.maxAttempts,
                nextRetryAt: this.now(),
                reason: "worker-exit",
                ...(reconnectDetail === undefined ? {} : { detail: reconnectDetail }),
              }
            : {
                status: "connecting",
                attempt,
                maxAttempts: this.policy.maxAttempts,
              },
        );
      }
      try {
        await this.host.start();
        if (this.disposed) {
          await this.host.stop();
          throw agentServiceDisconnectedError("连接管理器已关闭");
        }
        this.emit({
          status: "connected",
          attempt,
          maxAttempts: this.policy.maxAttempts,
          connectedAt: this.now(),
        });
        return;
      } catch (error) {
        if (this.disposed) throw agentServiceDisconnectedError("连接管理器已关闭");
        lastFailure = asStartFailure(error);
        if (attempt >= this.policy.maxAttempts) {
          this.emit({
            status: "unavailable",
            attempt,
            maxAttempts: this.policy.maxAttempts,
            reason: lastFailure.reason,
            detail: lastFailure.detail,
          });
          throw agentServiceDisconnectedError(lastFailure.detail);
        }
        const delayMs = this.retryDelay(attempt);
        this.emit({
          status: "reconnecting",
          attempt: attempt + 1,
          maxAttempts: this.policy.maxAttempts,
          nextRetryAt: this.now() + delayMs,
          reason: lastFailure.reason,
          detail: lastFailure.detail,
        });
        await this.wait(delayMs);
      }
    }
    throw agentServiceDisconnectedError(lastFailure?.detail ?? "连接失败");
  }

  private retryDelay(failureAttempt: number): number {
    const index = Math.min(failureAttempt - 1, this.policy.retryDelaysMs.length - 1);
    return this.policy.retryDelaysMs[index] ?? 0;
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.retryWake = resolve;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.retryWake = undefined;
        resolve();
      }, ms);
    });
  }

  private emit(input: ConnectionStateInput): void {
    this.revision += 1;
    this.state = {
      target: AGENT_CONNECTION_TARGET,
      revision: this.revision,
      updatedAt: this.now(),
      ...input,
    } as AgentConnectionState;
    for (const listener of this.listeners) listener(this.state);
  }
}

function asStartFailure(error: unknown): { reason: AgentConnectionReason; detail: string } {
  if (error instanceof AgentWorkerStartError) {
    return { reason: error.reason, detail: error.message };
  }
  return {
    reason: "worker-start-failed",
    detail: error instanceof Error ? error.message : String(error),
  };
}

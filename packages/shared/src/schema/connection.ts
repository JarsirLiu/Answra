import { z } from "zod";

/** 连接域唯一的运行时目标：桌面/CLI 客户端与 Agent worker 之间的链路。 */
export const AGENT_CONNECTION_TARGET = "agent-service";

/**
 * 连接失败原因。用稳定 code 而不是文案，供桌面、CLI 和未来客户端各自映射。
 * - `worker-exit`：worker 进程退出（含启动后崩溃）。
 * - `worker-start-failed`：宿主无法创建 worker。
 * - `readiness-timeout`：worker 已创建但就绪探测超时。
 */
export const agentConnectionReasonSchema = z.enum([
  "worker-exit",
  "worker-start-failed",
  "readiness-timeout",
]);

const connectionBase = {
  target: z.literal(AGENT_CONNECTION_TARGET),
  /** 单调递增，客户端据此丢弃乱序的旧快照。 */
  revision: z.number().int().nonnegative(),
  /** epoch 毫秒；跨 IPC/JSON 不依赖 Date 序列化。 */
  updatedAt: z.number().int().nonnegative(),
};

const attemptFields = {
  /** 本轮连接尝试序号：1 起，`unavailable` 时为最后一次。 */
  attempt: z.number().int().positive(),
  /** 本轮最多尝试次数；由状态携带，客户端不写死。 */
  maxAttempts: z.number().int().positive(),
};

/**
 * Agent 连接状态。一次 episode 内最多尝试 `maxAttempts` 次：
 * 初次启动 `connecting`，失败后退避进入 `reconnecting`，
 * 用尽后 `unavailable`；下一次显式启动开启新 episode。
 */
export const agentConnectionStateSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...connectionBase,
    ...attemptFields,
    status: z.literal("connecting"),
  }),
  z.strictObject({
    ...connectionBase,
    ...attemptFields,
    status: z.literal("connected"),
    connectedAt: z.number().int().nonnegative(),
  }),
  z.strictObject({
    ...connectionBase,
    ...attemptFields,
    status: z.literal("reconnecting"),
    /** 当前重连尝试的计划时间；等待退避时在未来。 */
    nextRetryAt: z.number().int().nonnegative(),
    reason: agentConnectionReasonSchema,
    detail: z.string().optional(),
  }),
  z.strictObject({
    ...connectionBase,
    ...attemptFields,
    status: z.literal("unavailable"),
    reason: agentConnectionReasonSchema,
    detail: z.string().optional(),
  }),
]);

export type AgentConnectionReason = z.infer<typeof agentConnectionReasonSchema>;
export type AgentConnectionState = z.infer<typeof agentConnectionStateSchema>;

/**
 * worker 链路失败的稳定错误码。UI 识别它后交给连接提示，不能再显示成模型错误。
 */
export const AGENT_SERVICE_DISCONNECTED_CODE = "agent-service-disconnected";

export function agentServiceDisconnectedError(detail: string): Error {
  return new Error(`${AGENT_SERVICE_DISCONNECTED_CODE}: ${detail}`);
}

export function isAgentServiceDisconnectedError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  return message.includes(AGENT_SERVICE_DISCONNECTED_CODE);
}

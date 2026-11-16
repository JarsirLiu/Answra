/** shell 会话的公开快照、内部状态与等待策略；不持有进程或输出缓冲。 */

import type { StreamingShellDecoder } from "../../../text/streamDecoder";
import type { ShellSyntax } from "../shell/runtime";

export type ShellSessionStatus = "running" | "completed" | "timed_out" | "killed";

export interface ShellSessionSnapshot {
  readonly status: ShellSessionStatus;
  readonly sessionId?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly outputTruncated?: boolean;
  readonly outputOmittedBytes?: number;
}

export interface StartShellSessionOptions {
  readonly command: string;
  readonly cwd: string;
  readonly yieldTimeMs?: number;
  readonly timeoutMs?: number;
  readonly maxOutputLength?: number;
  readonly signal?: AbortSignal;
}

export interface WriteShellSessionOptions {
  readonly sessionId: string;
  readonly chars?: string;
  readonly yieldTimeMs?: number;
  readonly maxOutputLength?: number;
  readonly signal?: AbortSignal;
}

export class ShellSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Shell session 不存在: ${sessionId}`);
    this.name = "ShellSessionNotFoundError";
  }
}

export type TerminalReason = "aborted" | "timed_out" | "cleanup";
export type OutputStream = "stdout" | "stderr";

export type Session = {
  readonly child: import("node:child_process").ChildProcess;
  readonly jobMarkerPath?: string | undefined;
  readonly shellSyntax: ShellSyntax;
  readonly stdoutText: string[];
  readonly stderrText: string[];
  readonly stdoutDecoder: StreamingShellDecoder;
  readonly stderrDecoder: StreamingShellDecoder;
  readonly done: Promise<void>;
  readonly terminationStarted: Promise<void>;
  termination?: Promise<void>;
  readonly ownerSignal?: AbortSignal;
  ownerAbort?: () => void;
  resolveDone: () => void;
  resolveTerminationStarted: () => void;
  interactionTail: Promise<void>;
  timeout: ReturnType<typeof setTimeout> | undefined;
  terminalReason?: TerminalReason;
  exitCode: number | null | undefined;
  signal: string | null | undefined;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutEmittedChars: number;
  stderrEmittedChars: number;
  outputTruncated: boolean;
  outputOmittedBytes: number;
  lastAccess: number;
};

export interface ShellSessionManagerOptions {
  readonly maxSessions?: number;
  readonly yieldTimePolicy?: ShellYieldTimePolicy;
}

export type ShellYieldTimePolicy = (options: {
  readonly phase: "start" | "write";
  readonly hasInput: boolean;
  readonly requestedMs?: number;
}) => number;

export const DEFAULT_YIELD_MS = 10_000;
const MIN_YIELD_MS = 250;
const MIN_EMPTY_YIELD_MS = 5_000;
const MAX_YIELD_MS = 30_000;
const MAX_EMPTY_YIELD_MS = 300_000;
const WINDOWS_INITIAL_YIELD_FLOOR_MS = 10_000;
export const DEFAULT_MAX_OUTPUT = 8_000;
export const MAX_SESSIONS = 32;
export const SHUTDOWN_WAIT_MS = 5_000;

export function normalizeSessionLimit(value: number | undefined): number {
  if (value === undefined) return MAX_SESSIONS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_SESSIONS) {
    throw new Error(`Shell 会话数量上限必须在 1 到 ${MAX_SESSIONS} 之间。`);
  }
  return value;
}

export function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function normalizeOptionalPositiveInteger(
  value: number | undefined,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数。`);
  return value;
}

export function normalizeShellYieldTime(options: Parameters<ShellYieldTimePolicy>[0]): number {
  const requestedMs = normalizePositiveInteger(options.requestedMs, DEFAULT_YIELD_MS);
  const minimum = options.hasInput || options.phase === "start" ? MIN_YIELD_MS : MIN_EMPTY_YIELD_MS;
  const maximum = options.hasInput || options.phase === "start" ? MAX_YIELD_MS : MAX_EMPTY_YIELD_MS;
  const windowsInitialFloor =
    process.platform === "win32" && options.phase === "start"
      ? WINDOWS_INITIAL_YIELD_FLOOR_MS
      : minimum;
  return Math.min(Math.max(requestedMs, windowsInitialFloor), maximum);
}

export function defaultYieldTimePolicy(options: Parameters<ShellYieldTimePolicy>[0]): number {
  return normalizeShellYieldTime(options);
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

export function createAbortError(): Error {
  const error = new Error("命令执行已取消");
  error.name = "AbortError";
  return error;
}

/**
 * 可续接的 shell 会话：一次 start 在等待窗口内返回增量输出或 sessionId，
 * 后续 writeStdin 继续等待或写入 stdin；会话按 LRU 淘汰，进程树由
 * processTree.ts 统一收割。
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildWindowsJobBootstrap, JOB_MARKER_ENV, terminateProcessTree } from "./processTree";
import {
  buildShellInvocation,
  decodeShellOutput,
  SHELL_OUTPUT_BUFFER_BYTES,
  stripPowerShellErrorWrapper,
  truncateShellOutput,
} from "./runtime";

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

type TerminalReason = "aborted" | "timed_out" | "cleanup";
type OutputStream = "stdout" | "stderr";
type Session = {
  readonly child: ChildProcess;
  readonly jobMarkerPath?: string | undefined;
  readonly stdout: Buffer[];
  readonly stderr: Buffer[];
  readonly done: Promise<void>;
  termination?: Promise<void>;
  readonly ownerSignal?: AbortSignal;
  ownerAbort?: () => void;
  resolveDone: () => void;
  interactionTail: Promise<void>;
  timeout: ReturnType<typeof setTimeout> | undefined;
  terminalReason?: TerminalReason;
  exitCode: number | null | undefined;
  signal: string | null | undefined;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutOffset: number;
  stderrOffset: number;
  outputTruncated: boolean;
  outputOmittedBytes: number;
  lastAccess: number;
};

const DEFAULT_YIELD_MS = 10_000;
const MIN_YIELD_MS = 250;
const MIN_EMPTY_YIELD_MS = 5_000;
const MAX_YIELD_MS = 30_000;
const MAX_EMPTY_YIELD_MS = 300_000;
const WINDOWS_INITIAL_YIELD_FLOOR_MS = 10_000;
const DEFAULT_MAX_OUTPUT = 8_000;
const MAX_SESSIONS = 32;
const SHUTDOWN_WAIT_MS = 5_000;

export interface ShellSessionManagerOptions {
  readonly maxSessions?: number;
  readonly yieldTimePolicy?: ShellYieldTimePolicy;
}

export type ShellYieldTimePolicy = (options: {
  readonly phase: "start" | "write";
  readonly hasInput: boolean;
  readonly requestedMs?: number;
}) => number;

export class ShellSessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly pendingShutdowns = new Set<Promise<void>>();
  private accessSequence = 0;
  private readonly maxSessions: number;
  private readonly yieldTimePolicy: ShellYieldTimePolicy;

  constructor(options: ShellSessionManagerOptions = {}) {
    this.maxSessions = normalizeSessionLimit(options.maxSessions);
    this.yieldTimePolicy = options.yieldTimePolicy ?? defaultYieldTimePolicy;
  }

  async start(options: StartShellSessionOptions): Promise<ShellSessionSnapshot> {
    throwIfAborted(options.signal);
    const timeoutMs = normalizeOptionalPositiveInteger(options.timeoutMs, "timeoutMs");
    this.pruneSessionsIfNeeded();

    const id = randomUUID();
    const session = this.createSession(id, options, timeoutMs);
    this.sessions.set(id, session);
    try {
      await this.wait(
        session,
        this.yieldTime({
          phase: "start",
          hasInput: false,
          ...(options.yieldTimeMs !== undefined && { requestedMs: options.yieldTimeMs }),
        }),
      );
      this.throwIfSessionAborted(session);
      return this.snapshot(id, session, options.maxOutputLength);
    } catch (error: unknown) {
      this.removeSession(id, session);
      if (!this.isFinished(session)) this.terminate(session, "cleanup");
      this.trackShutdown(session);
      throw error;
    }
  }

  async writeStdin(options: WriteShellSessionOptions): Promise<ShellSessionSnapshot> {
    throwIfAborted(options.signal);
    const session = this.get(options.sessionId);
    return this.serializeInteraction(session, async () => {
      if (this.sessions.get(options.sessionId) !== session)
        throw new ShellSessionNotFoundError(options.sessionId);
      return this.withAbortSignal(options.sessionId, session, options.signal, async () => {
        session.lastAccess = this.nextAccess();
        this.throwIfSessionAborted(session);
        if (!this.isFinished(session) && options.chars)
          await this.writeInput(session, options.chars);
        await this.wait(
          session,
          this.yieldTime({
            phase: "write",
            hasInput: Boolean(options.chars),
            ...(options.yieldTimeMs !== undefined && { requestedMs: options.yieldTimeMs }),
          }),
        );
        this.throwIfSessionAborted(session);
        return this.snapshot(options.sessionId, session, options.maxOutputLength);
      });
    });
  }

  async kill(id: string): Promise<void> {
    const session = this.get(id);
    this.terminate(session, "cleanup");
    this.removeSession(id, session);
    await this.waitForShutdown(session);
  }

  async cleanup(): Promise<void> {
    const sessions = [...this.sessions.entries()];
    for (const [id, session] of sessions) {
      this.terminate(session, "cleanup");
      this.removeSession(id, session);
    }
    await Promise.all([
      ...sessions.map(([, session]) => this.waitForShutdown(session)),
      ...this.pendingShutdowns,
    ]);
  }

  private createSession(
    id: string,
    options: StartShellSessionOptions,
    timeoutMs: number | undefined,
  ): Session {
    const { child, jobMarkerPath } = this.spawn(options.command, options.cwd);
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const session: Session = {
      child,
      jobMarkerPath,
      stdout: [],
      stderr: [],
      done,
      resolveDone,
      interactionTail: Promise.resolve(),
      timeout: undefined,
      exitCode: undefined,
      signal: undefined,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutOffset: 0,
      stderrOffset: 0,
      outputTruncated: false,
      outputOmittedBytes: 0,
      lastAccess: this.nextAccess(),
      ...(options.signal !== undefined && { ownerSignal: options.signal }),
    };

    child.stdout?.on("data", (data: Buffer) => this.append(session, "stdout", data));
    child.stderr?.on("data", (data: Buffer) => this.append(session, "stderr", data));
    child.on("error", (error: Error) => this.handleSpawnError(session, error));
    child.on("close", (code, closeSignal) => this.handleClose(session, code, closeSignal));
    if (timeoutMs !== undefined) {
      session.timeout = setTimeout(() => this.terminate(session, "timed_out"), timeoutMs);
      session.timeout.unref();
    }
    this.bindOwnerAbort(id, session, options.signal);
    return session;
  }

  private bindOwnerAbort(id: string, session: Session, signal?: AbortSignal): void {
    if (!signal) return;
    const ownerAbort = (): void => {
      this.terminate(session, "aborted");
      this.removeSession(id, session);
      this.trackShutdown(session);
    };
    session.ownerAbort = ownerAbort;
    signal.addEventListener("abort", ownerAbort, { once: true });
    if (signal.aborted) ownerAbort();
  }

  private append(session: Session, stream: OutputStream, data: Buffer): void {
    const availableBytes = Math.max(
      SHELL_OUTPUT_BUFFER_BYTES - session.stdoutBytes - session.stderrBytes,
      0,
    );
    if (availableBytes === 0) {
      session.outputTruncated = true;
      session.outputOmittedBytes += data.length;
      return;
    }

    const chunk = Buffer.from(data.subarray(0, availableBytes));
    session[stream].push(chunk);
    if (stream === "stdout") session.stdoutBytes += chunk.length;
    else session.stderrBytes += chunk.length;
    if (chunk.length < data.length) {
      session.outputTruncated = true;
      session.outputOmittedBytes += data.length - chunk.length;
    }
  }

  private handleSpawnError(session: Session, error: Error): void {
    this.append(session, "stderr", Buffer.from(error.message, "utf8"));
    session.exitCode = 1;
    this.resolveProcessExit(session);
  }

  private handleClose(session: Session, code: number | null, signal: NodeJS.Signals | null): void {
    if (session.terminalReason === undefined) {
      session.exitCode = code;
      session.signal = signal;
    }
    this.resolveProcessExit(session);
    this.releaseJobMarker(session);
  }

  private releaseJobMarker(session: Session): void {
    if (!session.jobMarkerPath) return;
    void rm(session.jobMarkerPath, { force: true }).catch(() => undefined);
  }

  private resolveProcessExit(session: Session): void {
    this.clearTimeout(session);
    session.resolveDone();
  }

  private terminate(session: Session, reason: TerminalReason): void {
    if (!this.markTerminated(session, reason)) return;
    session.termination = terminateProcessTree(session.child, session.jobMarkerPath);
  }

  private markTerminated(session: Session, reason: TerminalReason): boolean {
    if (this.isFinished(session)) return false;
    session.terminalReason = reason;
    session.exitCode = null;
    session.signal = "SIGTERM";
    this.clearTimeout(session);
    return true;
  }

  private clearTimeout(session: Session): void {
    if (session.timeout) clearTimeout(session.timeout);
    session.timeout = undefined;
  }

  private async wait(session: Session, milliseconds?: number): Promise<void> {
    if (this.isFinished(session)) return;
    const termination = session.termination;
    const waitForTermination = termination ?? new Promise<void>(() => undefined);
    await Promise.race([
      session.done,
      waitForTermination,
      delay(normalizePositiveInteger(milliseconds, DEFAULT_YIELD_MS)),
    ]);
  }

  private yieldTime(options: Parameters<ShellYieldTimePolicy>[0]): number {
    return this.yieldTimePolicy(options);
  }

  private async writeInput(session: Session, chars: string): Promise<void> {
    const stdin = session.child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable)
      throw new Error("Shell session 的 stdin 不可写。");
    await new Promise<void>((resolve, reject) => {
      stdin.write(chars, (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private snapshot(id: string, session: Session, maxOutputLength?: number): ShellSessionSnapshot {
    const limit = normalizePositiveInteger(maxOutputLength, DEFAULT_MAX_OUTPUT);
    const stdout = Buffer.concat(session.stdout, session.stdoutBytes);
    const stderr = Buffer.concat(session.stderr, session.stderrBytes);
    const stdoutResult = truncateShellOutput(
      decodeShellOutput(stdout.subarray(session.stdoutOffset)),
      limit,
    );
    const stderrText = decodeShellOutput(stderr.subarray(session.stderrOffset));
    const stderrResult = truncateShellOutput(
      process.platform === "win32" ? stripPowerShellErrorWrapper(stderrText) : stderrText,
      limit,
    );
    session.stdoutOffset = stdout.length;
    session.stderrOffset = stderr.length;

    const status = this.statusOf(session);
    const outputTruncated =
      session.outputTruncated || stdoutResult.truncated || stderrResult.truncated;
    return {
      status,
      sessionId: id,
      stdout: stdoutResult.value,
      stderr: stderrResult.value,
      ...(status !== "running" && { exitCode: session.exitCode ?? null }),
      ...(session.signal !== undefined && { signal: session.signal }),
      ...(outputTruncated && { outputTruncated: true }),
      ...(session.outputOmittedBytes > 0 && { outputOmittedBytes: session.outputOmittedBytes }),
    };
  }

  private trackShutdown(session: Session): void {
    const shutdown = this.waitForShutdown(session);
    this.pendingShutdowns.add(shutdown);
    void shutdown.finally(() => this.pendingShutdowns.delete(shutdown));
  }

  private async waitForShutdown(session: Session): Promise<void> {
    await Promise.race([session.termination ?? Promise.resolve(), delay(SHUTDOWN_WAIT_MS)]);
  }

  private statusOf(session: Session): ShellSessionStatus {
    if (session.terminalReason === "timed_out") return "timed_out";
    if (session.terminalReason === "cleanup") return "killed";
    if (session.exitCode !== undefined) return "completed";
    return "running";
  }

  private throwIfSessionAborted(session: Session): void {
    if (session.terminalReason === "aborted") throw createAbortError();
  }

  private isFinished(session: Session): boolean {
    return session.terminalReason !== undefined || session.exitCode !== undefined;
  }

  private get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new ShellSessionNotFoundError(id);
    return session;
  }

  private nextAccess(): number {
    this.accessSequence += 1;
    return this.accessSequence;
  }

  private pruneSessionsIfNeeded(): void {
    if (this.sessions.size < this.maxSessions) return;

    const entries = [...this.sessions.entries()];
    const recentIds = new Set(
      entries
        .sort(([, left], [, right]) => right.lastAccess - left.lastAccess)
        .slice(0, Math.min(8, Math.max(entries.length - 1, 0)))
        .map(([id]) => id),
    );
    const candidates = entries
      .filter(([id]) => !recentIds.has(id))
      .sort(([leftId, left], [rightId, right]) => {
        const leftFinished = this.isFinished(left) ? 0 : 1;
        const rightFinished = this.isFinished(right) ? 0 : 1;
        return (
          leftFinished - rightFinished ||
          left.lastAccess - right.lastAccess ||
          leftId.localeCompare(rightId)
        );
      });
    const candidate = candidates[0];
    if (!candidate) throw new Error("Shell 会话无法安全淘汰。");

    const [id, session] = candidate;
    this.removeSession(id, session);
    if (!this.isFinished(session)) {
      this.terminate(session, "cleanup");
      this.trackShutdown(session);
    }
  }

  private removeSession(id: string, session: Session): void {
    if (this.sessions.get(id) === session) this.sessions.delete(id);
    if (session.ownerSignal && session.ownerAbort)
      session.ownerSignal.removeEventListener("abort", session.ownerAbort);
  }

  private async serializeInteraction(
    session: Session,
    operation: () => Promise<ShellSessionSnapshot>,
  ): Promise<ShellSessionSnapshot> {
    const previous = session.interactionTail;
    let release: () => void = () => undefined;
    session.interactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async withAbortSignal(
    id: string,
    session: Session,
    signal: AbortSignal | undefined,
    operation: () => Promise<ShellSessionSnapshot>,
  ): Promise<ShellSessionSnapshot> {
    if (!signal || signal === session.ownerSignal) return operation();
    const abort = (): void => {
      this.terminate(session, "aborted");
      this.removeSession(id, session);
      this.trackShutdown(session);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) abort();
      return await operation();
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  private spawn(
    command: string,
    cwd: string,
  ): { readonly child: ChildProcess; readonly jobMarkerPath?: string | undefined } {
    const windows = process.platform === "win32";
    // Windows 下每个会话独立 marker 文件，反馈 Job Object containment 结果。
    const jobMarkerPath = windows
      ? path.join(os.tmpdir(), `answra-shell-job-${randomUUID()}.marker`)
      : undefined;
    const invocation = buildShellInvocation(
      command,
      windows ? { windowsBootstrap: buildWindowsJobBootstrap() } : {},
    );
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      windowsHide: true,
      detached: !windows,
      stdio: ["pipe", "pipe", "pipe"],
      ...(jobMarkerPath && { env: { ...process.env, [JOB_MARKER_ENV]: jobMarkerPath } }),
    });
    return { child, jobMarkerPath };
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

function normalizeSessionLimit(value: number | undefined): number {
  if (value === undefined) return MAX_SESSIONS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_SESSIONS) {
    throw new Error(`Shell 会话数量上限必须在 1 到 ${MAX_SESSIONS} 之间。`);
  }
  return value;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeOptionalPositiveInteger(
  value: number | undefined,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数。`);
  return value;
}

function defaultYieldTimePolicy(options: Parameters<ShellYieldTimePolicy>[0]): number {
  return normalizeShellYieldTime(options);
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

function createAbortError(): Error {
  const error = new Error("命令执行已取消");
  error.name = "AbortError";
  return error;
}

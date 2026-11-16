/**
 * 可续接的 shell 会话：一次 start 在等待窗口内返回增量输出或 sessionId，
 * 后续 RunCommand 以 sessionId 继续等待或写入 stdin；会话按 LRU 淘汰，进程树由
 * processTree.ts 统一收割。
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StreamingShellDecoder } from "../../../text/streamDecoder";
import { buildShellInvocation } from "../shell/runtime";
import { buildWindowsJobBootstrap, JOB_MARKER_ENV, terminateProcessTree } from "./processTree";
import {
  createAbortError,
  DEFAULT_YIELD_MS,
  defaultYieldTimePolicy,
  delay,
  normalizeOptionalPositiveInteger,
  normalizePositiveInteger,
  normalizeSessionLimit,
  type Session,
  SHUTDOWN_WAIT_MS,
  type ShellSessionManagerOptions,
  ShellSessionNotFoundError,
  type ShellSessionSnapshot,
  type ShellYieldTimePolicy,
  type StartShellSessionOptions,
  type TerminalReason,
  throwIfAborted,
  type WriteShellSessionOptions,
} from "./sessionContract";
import {
  appendSessionOutput,
  flushSessionDecoders,
  isSessionFinished,
  snapshotSession,
} from "./sessionOutput";

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
      return snapshotSession(id, session, options.maxOutputLength);
    } catch (error: unknown) {
      this.removeSession(id, session);
      if (!isSessionFinished(session)) this.terminate(session, "cleanup");
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
        if (!isSessionFinished(session) && options.chars)
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
        return snapshotSession(options.sessionId, session, options.maxOutputLength);
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
    const { child, jobMarkerPath, shellSyntax } = this.spawn(options.command, options.cwd);
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let resolveTerminationStarted: () => void = () => undefined;
    const terminationStarted = new Promise<void>((resolve) => {
      resolveTerminationStarted = resolve;
    });
    const session: Session = {
      child,
      jobMarkerPath,
      shellSyntax,
      stdoutText: [],
      stderrText: [],
      stdoutDecoder: new StreamingShellDecoder(),
      stderrDecoder: new StreamingShellDecoder(),
      done,
      terminationStarted,
      resolveDone,
      resolveTerminationStarted,
      interactionTail: Promise.resolve(),
      timeout: undefined,
      exitCode: undefined,
      signal: undefined,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutEmittedChars: 0,
      stderrEmittedChars: 0,
      outputTruncated: false,
      outputOmittedBytes: 0,
      lastAccess: this.nextAccess(),
      ...(options.signal !== undefined && { ownerSignal: options.signal }),
    };

    child.stdout?.on("data", (data: Buffer) => appendSessionOutput(session, "stdout", data));
    child.stderr?.on("data", (data: Buffer) => appendSessionOutput(session, "stderr", data));
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

  private handleSpawnError(session: Session, error: Error): void {
    appendSessionOutput(session, "stderr", Buffer.from(error.message, "utf8"));
    session.exitCode = 1;
    this.resolveProcessExit(session);
  }

  private handleClose(session: Session, code: number | null, signal: NodeJS.Signals | null): void {
    flushSessionDecoders(session);
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
    if (isSessionFinished(session)) return false;
    session.terminalReason = reason;
    session.exitCode = null;
    session.signal = "SIGTERM";
    this.clearTimeout(session);
    session.resolveTerminationStarted();
    return true;
  }

  private clearTimeout(session: Session): void {
    if (session.timeout) clearTimeout(session.timeout);
    session.timeout = undefined;
  }

  private async wait(session: Session, milliseconds?: number): Promise<void> {
    if (isSessionFinished(session)) return;
    await Promise.race([
      session.done,
      session.terminationStarted,
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

  private trackShutdown(session: Session): void {
    const shutdown = this.waitForShutdown(session);
    this.pendingShutdowns.add(shutdown);
    void shutdown.finally(() => this.pendingShutdowns.delete(shutdown));
  }

  private async waitForShutdown(session: Session): Promise<void> {
    await Promise.race([session.termination ?? Promise.resolve(), delay(SHUTDOWN_WAIT_MS)]);
  }

  private throwIfSessionAborted(session: Session): void {
    if (session.terminalReason === "aborted") throw createAbortError();
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
        const leftFinished = isSessionFinished(left) ? 0 : 1;
        const rightFinished = isSessionFinished(right) ? 0 : 1;
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
    if (!isSessionFinished(session)) {
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
  ): {
    readonly child: ChildProcess;
    readonly jobMarkerPath?: string | undefined;
    readonly shellSyntax: "posix" | "powershell" | "cmd";
  } {
    const windows = process.platform === "win32";
    // Windows 每个会话都用 marker 文件把 Job Object containment 结果带回。
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
    return { child, jobMarkerPath, shellSyntax: invocation.syntax };
  }
}

export type {
  ShellSessionSnapshot,
  ShellSessionStatus,
  ShellYieldTimePolicy,
  StartShellSessionOptions,
  WriteShellSessionOptions,
} from "./sessionContract";
export { normalizeShellYieldTime, ShellSessionNotFoundError } from "./sessionContract";

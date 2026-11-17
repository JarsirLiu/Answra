/**
 * 一次性 shell 命令执行器：spawn 后在超时/取消/输出超限时终止整棵进程树。
 * 长命令与 stdin 交互由 sessions.ts 负责，不在本文件维护会话状态。
 */

import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  decodeShellOutput,
  SHELL_OUTPUT_BUFFER_BYTES,
  stripPowerShellErrorWrapper,
  truncateShellOutput,
} from "../shell/runtime";
import { terminateProcessTree } from "./processTree";
import { removeShellJobMarker, spawnShellProcess } from "./spawn";

export interface ShellAction {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxOutputLength?: number;
  /** 结束前的增量输出；只用于实时预览，最终结果仍以 ShellOutputResult 为准。 */
  readonly onOutput?: (delta: string) => void;
}

export interface ShellOutputResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly outcome: { readonly type: "exit" | "timeout"; readonly exitCode?: number | null };
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_LENGTH = 8_000;
const EXIT_DRAIN_MS = 2_000;

type TerminationReason = "timeout" | "aborted" | "output-limit";
type ShellStream = "stdout" | "stderr";

interface ShellProcessOptions {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputLength: number;
  readonly signal: AbortSignal | undefined;
  readonly onOutput?: (delta: string) => void;
}

interface ShellProcessState {
  readonly child: ChildProcess;
  readonly jobMarkerPath?: string;
  readonly output: OutputCollector;
  readonly syntax: "posix" | "powershell" | "cmd";
  readonly signal: AbortSignal | undefined;
  readonly maxOutputLength: number;
  exitCode: number | null;
  terminationReason: TerminationReason | undefined;
  terminationStarted: boolean;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  drainTimer: ReturnType<typeof setTimeout> | undefined;
  termination: Promise<void> | undefined;
  onAbort: () => void;
}

export class LocalShell {
  async run(action: ShellAction, signal?: AbortSignal): Promise<ShellOutputResult> {
    const timeoutMs = normalizePositiveInteger(action.timeoutMs, DEFAULT_TIMEOUT_MS);
    const maxOutputLength = normalizePositiveInteger(
      action.maxOutputLength,
      DEFAULT_MAX_OUTPUT_LENGTH,
    );

    return runShellProcess({
      command: action.command,
      cwd: action.cwd,
      timeoutMs,
      maxOutputLength,
      signal,
      ...(action.onOutput ? { onOutput: action.onOutput } : {}),
    });
  }
}

function runShellProcess(options: ShellProcessOptions): Promise<ShellOutputResult> {
  if (options.signal?.aborted) return Promise.reject(createAbortError());

  return new Promise((resolve, reject) => {
    const spawned = spawnShellProcess({
      command: options.command,
      cwd: options.cwd,
      stdin: "ignore",
    });
    const child = spawned.child;
    const state: ShellProcessState = {
      child,
      ...(spawned.jobMarkerPath && { jobMarkerPath: spawned.jobMarkerPath }),
      output: new OutputCollector(),
      syntax: spawned.shellSyntax,
      signal: options.signal,
      maxOutputLength: options.maxOutputLength,
      exitCode: null,
      terminationReason: undefined,
      terminationStarted: false,
      settled: false,
      timer: undefined,
      drainTimer: undefined,
      termination: undefined,
      onAbort: () => undefined,
    };

    state.onAbort = (): void => terminateShellProcess(state, "aborted");
    options.signal?.addEventListener("abort", state.onAbort, { once: true });
    state.timer = setTimeout(() => terminateShellProcess(state, "timeout"), options.timeoutMs);
    state.timer.unref();
    // 覆盖 spawn 与监听注册之间发生的取消，避免漏掉 AbortSignal。
    if (options.signal?.aborted) terminateShellProcess(state, "aborted");

    const decoders: Record<ShellStream, StringDecoder> = {
      stdout: new StringDecoder("utf8"),
      stderr: new StringDecoder("utf8"),
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      appendShellOutput(state, "stdout", chunk);
      emitShellDelta(options, decoders.stdout.write(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      appendShellOutput(state, "stderr", chunk);
      emitShellDelta(options, decoders.stderr.write(chunk));
    });
    child.on("error", (error: Error) => settleShellProcess(state, resolve, reject, error));
    child.on("exit", (code: number | null) => {
      state.exitCode = code;
      scheduleDrainSettle(state, resolve, reject);
    });
    child.on("close", (code: number | null) => {
      state.exitCode = code;
      emitShellDelta(options, decoders.stdout.end());
      emitShellDelta(options, decoders.stderr.end());
      settleShellProcess(state, resolve, reject);
    });
  });
}

function scheduleDrainSettle(
  state: ShellProcessState,
  resolve: (result: ShellOutputResult) => void,
  reject: (error: Error) => void,
): void {
  if (state.settled || state.drainTimer) return;
  state.drainTimer = setTimeout(() => {
    state.drainTimer = undefined;
    if (state.termination) {
      void state.termination.then(() => settleShellProcess(state, resolve, reject));
      return;
    }
    settleShellProcess(state, resolve, reject);
  }, EXIT_DRAIN_MS);
  state.drainTimer.unref();
}

function emitShellDelta(options: ShellProcessOptions, delta: string): void {
  if (delta) options.onOutput?.(delta);
}

function terminateShellProcess(state: ShellProcessState, reason: TerminationReason): void {
  state.terminationReason ??= reason;
  if (state.terminationStarted) return;
  state.terminationStarted = true;
  if (state.timer) clearTimeout(state.timer);
  state.timer = undefined;
  state.termination = terminateProcessTree(state.child, state.jobMarkerPath).catch(() => undefined);
}

function appendShellOutput(state: ShellProcessState, stream: ShellStream, chunk: Buffer): void {
  if (!state.output.append(stream, chunk)) terminateShellProcess(state, "output-limit");
}

function settleShellProcess(
  state: ShellProcessState,
  resolve: (result: ShellOutputResult) => void,
  reject: (error: Error) => void,
  error?: Error,
): void {
  if (state.settled) return;
  state.settled = true;
  if (state.timer) clearTimeout(state.timer);
  state.timer = undefined;
  if (state.drainTimer) clearTimeout(state.drainTimer);
  state.drainTimer = undefined;
  state.signal?.removeEventListener("abort", state.onAbort);
  state.child.stdout?.destroy();
  state.child.stderr?.destroy();
  state.child.stdin?.destroy();
  if (state.termination)
    void state.termination.then(() => removeShellJobMarker(state.jobMarkerPath));
  else void removeShellJobMarker(state.jobMarkerPath);

  if (state.terminationReason === "aborted" || state.signal?.aborted) {
    reject(createAbortError());
    return;
  }

  const stdout = state.output.snapshot(state.maxOutputLength);
  const stderr = formatShellStderr(stdout.stderr, state.syntax, state.terminationReason, error);
  if (state.terminationReason === "timeout") {
    resolve({ stdout: stdout.stdout, stderr, outcome: { type: "timeout" } });
    return;
  }

  resolve({
    stdout: stdout.stdout,
    stderr,
    outcome: {
      type: "exit",
      exitCode: state.terminationReason === "output-limit" ? 1 : (state.exitCode ?? 1),
    },
  });
}

function formatShellStderr(
  stderr: string,
  syntax: "posix" | "powershell" | "cmd",
  reason: TerminationReason | undefined,
  error: Error | undefined,
): string {
  const cleaned = syntax === "powershell" ? stripPowerShellErrorWrapper(stderr) : stderr;
  if (reason === "output-limit") {
    return [
      cleaned,
      `Output exceeded ${SHELL_OUTPUT_BUFFER_BYTES} bytes and the command was terminated.`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (error) return cleaned || error.message;
  return cleaned;
}

class OutputCollector {
  private readonly stdout: Buffer[] = [];
  private readonly stderr: Buffer[] = [];
  private stdoutBytes = 0;
  private stderrBytes = 0;

  append(stream: ShellStream, chunk: Buffer): boolean {
    const availableBytes = Math.max(
      SHELL_OUTPUT_BUFFER_BYTES - this.stdoutBytes - this.stderrBytes,
      0,
    );
    if (chunk.length > availableBytes) {
      if (availableBytes > 0) this.push(stream, chunk.subarray(0, availableBytes));
      return false;
    }
    this.push(stream, chunk);
    return true;
  }

  snapshot(maxOutputLength: number): { readonly stdout: string; readonly stderr: string } {
    return {
      stdout: truncateShellOutput(
        decodeShellOutput(Buffer.concat(this.stdout, this.stdoutBytes)),
        maxOutputLength,
      ).value,
      stderr: truncateShellOutput(
        decodeShellOutput(Buffer.concat(this.stderr, this.stderrBytes)),
        maxOutputLength,
      ).value,
    };
  }

  private push(stream: ShellStream, chunk: Buffer): void {
    if (stream === "stdout") {
      this.stdout.push(chunk);
      this.stdoutBytes += chunk.length;
      return;
    }
    this.stderr.push(chunk);
    this.stderrBytes += chunk.length;
  }
}

function createAbortError(): Error {
  const error = new Error("命令执行已取消");
  error.name = "AbortError";
  return error;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

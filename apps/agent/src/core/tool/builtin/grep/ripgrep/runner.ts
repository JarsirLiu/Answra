/** ripgrep 执行：Agent 进程内直跑，或经 worker_threads 隔离 WASI。 */

import { Worker } from "node:worker_threads";
import { ripgrep } from "ripgrep";
import { ToolExecutionError } from "../../../executor/result";

export interface RipgrepResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface GrepWorkerResponse {
  readonly ok: boolean;
  readonly code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string;
}

export async function runRipgrep(
  args: readonly string[],
  searchRoot: string,
  workerPath: string | undefined,
  signal: AbortSignal,
): Promise<RipgrepResult> {
  if (workerPath) return runRipgrepInWorker(args, searchRoot, workerPath, signal);
  try {
    return await ripgrep(args, {
      buffer: true,
      preopens: { ".": searchRoot },
    });
  } catch (error) {
    throw new ToolExecutionError("handler-failed", errorMessage(error));
  }
}

export function createRipgrepError(stderr: string): ToolExecutionError {
  const detail = stderr.trim() || "ripgrep 执行失败";
  if (/regex parse error|error parsing glob|unrecognized flag/i.test(detail)) {
    return new ToolExecutionError("invalid-input", detail);
  }
  return new ToolExecutionError("handler-failed", detail);
}

function runRipgrepInWorker(
  args: readonly string[],
  searchRoot: string,
  workerPath: string,
  signal: AbortSignal,
): Promise<RipgrepResult> {
  if (signal.aborted) {
    return Promise.reject(new ToolExecutionError("aborted", "工具调用已取消"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(workerPath, { workerData: { args, searchRoot } });
    } catch (error) {
      reject(new ToolExecutionError("handler-failed", errorMessage(error)));
      return;
    }

    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate();
      action();
    };
    const onAbort = (): void => {
      settle(() => reject(new ToolExecutionError("aborted", "工具调用已取消")));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: GrepWorkerResponse) => {
      settle(() => {
        if (!message.ok) {
          reject(new ToolExecutionError("handler-failed", message.error ?? "Grep worker 失败"));
          return;
        }
        resolve({
          code: message.code ?? 2,
          stdout: message.stdout ?? "",
          stderr: message.stderr ?? "",
        });
      });
    });
    worker.once("error", (error) => {
      settle(() => reject(new ToolExecutionError("handler-failed", errorMessage(error))));
    });
    worker.once("exit", (code) => {
      settle(() => reject(new ToolExecutionError("handler-failed", `Grep worker 退出码 ${code}`)));
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Grep 执行失败";
}

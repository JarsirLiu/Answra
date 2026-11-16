/** Grep 的 worker_threads 入口：把阻塞的 WASI ripgrep 移出 Agent 主事件循环。 */

import { parentPort, workerData } from "node:worker_threads";
import { ripgrep } from "ripgrep";

interface GrepWorkerData {
  readonly args: readonly string[];
  readonly searchRoot: string;
}

interface GrepWorkerResponse {
  readonly ok: boolean;
  readonly code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string;
}

export function runGrepWorker(): void {
  const port = parentPort;
  if (!port) throw new Error("Grep worker 必须运行在 worker_threads 中");
  const data = workerData as GrepWorkerData;
  void executeGrepWorker(data)
    .then((response) => port.postMessage(response))
    .catch((error: unknown) => {
      const response: GrepWorkerResponse = {
        ok: false,
        error: error instanceof Error ? error.message : "Grep worker 失败",
      };
      port.postMessage(response);
    });
}

async function executeGrepWorker(data: GrepWorkerData): Promise<GrepWorkerResponse> {
  const result = await ripgrep(data.args, {
    buffer: true,
    preopens: { ".": data.searchRoot },
  });
  return {
    ok: true,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * 跨领域的 run 生命周期原语：登记 runId 与 AbortController，提供取消、完成信号与
 * 整体收尾。它不关心会话、消息或模型，领域 runtime 负责在 run 结束时调用 finish。
 */
export class RunRegistry {
  private readonly runs = new Map<string, RunRecord>();

  register(runId: string, controller: AbortController): void {
    this.runs.set(runId, { controller, completion: createRunCompletion() });
  }

  cancel(runId: string): void {
    this.runs.get(runId)?.controller.abort();
  }

  /** 已完成或未登记的 run 返回已 resolve 的 Promise。 */
  wait(runId: string): Promise<void> {
    return this.runs.get(runId)?.completion.promise ?? Promise.resolve();
  }

  /** run 落账后调用：先释放等待者，再移除登记。 */
  finish(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.completion.resolve();
    this.runs.delete(runId);
  }

  /** 进程退出：取消所有在途 run，并释放所有等待者。 */
  abortAll(): void {
    for (const run of this.runs.values()) {
      run.controller.abort();
      run.completion.resolve();
    }
    this.runs.clear();
  }

  get activeCount(): number {
    return this.runs.size;
  }
}

interface RunRecord {
  readonly controller: AbortController;
  readonly completion: RunCompletion;
}

interface RunCompletion {
  readonly promise: Promise<void>;
  resolve: () => void;
}

function createRunCompletion(): RunCompletion {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

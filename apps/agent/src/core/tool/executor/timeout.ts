/** 把工具自身超时与 run 取消合并成单个 AbortSignal；超时和取消都转成结构化失败。 */
import { ToolExecutionError } from "./result";

export async function runWithToolTimeout<T>(
  timeoutMs: number,
  parent: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parent.aborted) throw new ToolExecutionError("aborted", "工具调用已取消");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new ToolExecutionError("invalid-input", "工具超时必须为正数");

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent.reason);
  parent.addEventListener("abort", abortFromParent, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new ToolExecutionError("timeout", `工具执行超过 ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const cancelled = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(toAbortError(controller.signal.reason)),
      {
        once: true,
      },
    );
  });

  try {
    return await Promise.race([run(controller.signal), timeout, cancelled]);
  } catch (error) {
    if (controller.signal.aborted) throw toAbortError(controller.signal.reason);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    parent.removeEventListener("abort", abortFromParent);
  }
}

function toAbortError(reason: unknown): ToolExecutionError {
  if (reason instanceof ToolExecutionError) return reason;
  return new ToolExecutionError("aborted", "工具调用已取消");
}

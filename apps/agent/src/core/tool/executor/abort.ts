/** 工具执行入口的取消检查；工具实现只在边界调用一次。 */

export function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("工具调用已取消");
}

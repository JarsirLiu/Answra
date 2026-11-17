/** 进程终止路径使用的短延迟原语；不包含重试或生命周期策略。 */

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

/** 进程退出信号适配：按平台选择可订阅信号，并保证同一轮清理只触发一次。 */

export type InterruptSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGBREAK";

const POSIX_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const WINDOWS_SIGNALS = ["SIGINT", "SIGTERM", "SIGBREAK"] as const;

export interface ProcessSignalSource {
  on(signal: InterruptSignal, listener: () => void): unknown;
  off(signal: InterruptSignal, listener: () => void): unknown;
}

export interface ProcessInterruptOptions {
  readonly platform?: NodeJS.Platform;
  readonly source?: ProcessSignalSource;
}

export function interruptSignals(
  platform: NodeJS.Platform = process.platform,
): readonly InterruptSignal[] {
  return platform === "win32" ? WINDOWS_SIGNALS : POSIX_SIGNALS;
}

export function onProcessInterrupt(
  handler: () => void,
  options: ProcessInterruptOptions = {},
): () => void {
  const source = options.source ?? process;
  const signals = interruptSignals(options.platform ?? process.platform);
  let handled = false;
  const listener = (): void => {
    if (handled) return;
    handled = true;
    handler();
  };

  for (const signal of signals) source.on(signal, listener);
  return () => {
    for (const signal of signals) source.off(signal, listener);
  };
}

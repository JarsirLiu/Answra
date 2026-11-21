import type { RemoteSignalingTimers } from "@answra/remote";

/** 移动端计时器适配；只把 setTimeout 收敛成 RemoteSignalingTimers。 */
export function createMobileSignalingTimers(): RemoteSignalingTimers {
  return {
    after(delayMs, callback) {
      const handle = setTimeout(callback, delayMs);
      return () => clearTimeout(handle);
    },
  };
}

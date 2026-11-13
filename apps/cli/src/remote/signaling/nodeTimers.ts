/** Node 计时器适配：只由 CLI 组合根注入，信令状态机本身不直接使用全局计时器。 */
import type { RemoteSignalingTimers } from "@answra/remote";

export function createNodeSignalingTimers(): RemoteSignalingTimers {
  return {
    after(delayMs, callback) {
      const id = setTimeout(callback, delayMs);
      return () => clearTimeout(id);
    },
  };
}

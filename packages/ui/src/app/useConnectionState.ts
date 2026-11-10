import type { AgentConnectionState, DesktopBridge } from "@answra/shared";
import { useEffect, useState } from "react";

/**
 * 订阅 main 持有的 Agent worker 连接状态。状态对象携带单调 revision：
 * 初始快照与实时推送无论先后，只保留更新的那一份。
 */
export function useConnectionState(
  bridge: DesktopBridge | undefined,
): AgentConnectionState | undefined {
  const [state, setState] = useState<AgentConnectionState>();

  useEffect(() => {
    if (!bridge?.getConnectionState && !bridge?.onConnectionState) {
      setState(undefined);
      return;
    }
    let cancelled = false;
    let revision = -1;
    const apply = (next: AgentConnectionState) => {
      if (cancelled || next.revision < revision) return;
      revision = next.revision;
      setState(next);
    };
    const unsubscribe = bridge.onConnectionState?.(apply);
    void bridge
      .getConnectionState?.()
      .then(apply)
      .catch(() => {
        // 初始拉取失败不能抹掉订阅已经推来的更新状态。
        if (!cancelled && revision < 0) setState(undefined);
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [bridge]);

  return state;
}

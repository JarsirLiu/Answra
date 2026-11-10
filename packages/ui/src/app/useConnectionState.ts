import type { AgentConnectionState, DesktopBridge } from "@answra/shared";
import { useEffect, useRef, useState } from "react";

/**
 * 订阅 main 持有的 Agent worker 连接状态。启动阶段的后台连接尝试不进入 UI：
 * 只有成功连接过一次后，后续断链才作为可展示状态；初始快照与实时推送按 revision 取新。
 */
export function useConnectionState(
  bridge: DesktopBridge | undefined,
): AgentConnectionState | undefined {
  const [state, setState] = useState<AgentConnectionState>();
  const connectedOnce = useRef(false);

  useEffect(() => {
    if (!bridge?.getConnectionState && !bridge?.onConnectionState) {
      setState(undefined);
      return;
    }
    let cancelled = false;
    let revision = -1;
    const apply = (next: AgentConnectionState) => {
      if (next.status === "connected") connectedOnce.current = true;
      if (!connectedOnce.current || cancelled || next.revision < revision) return;
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

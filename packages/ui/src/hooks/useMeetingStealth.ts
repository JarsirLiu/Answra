import type { DesktopBridge } from "@answra/shared";
import { useEffect, useState } from "react";
import { STEALTH_STORAGE_KEY } from "../model";

/** 隐身状态、能力查询和主进程同步独立于主题开关。 */
export function useMeetingStealth(platform: DesktopBridge | undefined) {
  const [enabled, setEnabled] = useState(() => localStorage.getItem(STEALTH_STORAGE_KEY) === "on");
  const [supported, setSupported] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const query = platform?.getStealthSupport;
    if (!query) {
      console.warn("[settings][stealth] capability query unavailable");
      setSupported(false);
      return () => {
        cancelled = true;
      };
    }

    void query()
      .then((result) => {
        if (!cancelled) setSupported(result);
      })
      .catch((error: unknown) => {
        console.error("[stealth] 能力查询失败:", error);
        if (!cancelled) setSupported(false);
      });

    return () => {
      cancelled = true;
    };
  }, [platform]);

  useEffect(() => {
    if (supported === null) return;
    // 支持时同步持久化状态；无论检测结果如何，都允许发送关闭指令。
    if (supported || !enabled) {
      platform?.setStealth?.(enabled);
    } else {
      console.warn("[settings][stealth] enabled state is not applied: unsupported");
    }
  }, [enabled, platform, supported]);

  function setEnabledPersisted(value: boolean) {
    setEnabled(value);
    localStorage.setItem(STEALTH_STORAGE_KEY, value ? "on" : "off");
  }

  return {
    enabled,
    setEnabled: setEnabledPersisted,
    supported: supported === true,
  } as const;
}

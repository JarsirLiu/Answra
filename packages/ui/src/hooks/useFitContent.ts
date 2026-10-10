import type { DesktopBridge } from "@answra/shared";
import { useEffect, useRef } from "react";

/**
 * 外壳尺寸上报：ResizeObserver 观察 .overlay-root（fit-content 布局），
 * 尺寸变化即通过桥上报主进程调整窗口。窗口永远紧贴外壳内容。
 */
export function useFitContent(bridge: DesktopBridge | undefined): {
  ref: React.RefObject<HTMLElement | null>;
} {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || !bridge) return;

    const report = () => {
      const { offsetWidth, offsetHeight } = element;
      if (offsetWidth > 0 && offsetHeight > 0) {
        bridge.fitContent({ width: offsetWidth, height: offsetHeight });
      }
    };

    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [bridge]);

  return { ref };
}

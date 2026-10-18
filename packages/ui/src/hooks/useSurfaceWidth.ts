import type { RefObject } from "react";
import { useLayoutEffect } from "react";

/**
 * 面板跟随悬浮导航栏宽度：测量外壳内 `.floating-bar` 的实际宽度，写入 CSS 变量 `--surface-w`。
 * 对话/回复面板消费该变量，保证与导航栏默认同宽（导航栏为准）。
 * 在 useLayoutEffect 中同步写入，避免首帧先按回退值渲染再收缩造成跳动。
 */
export function useSurfaceWidth(rootRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const bar = root.querySelector<HTMLElement>(".floating-bar");
    if (!bar) return;

    const apply = () => {
      const width = bar.offsetWidth;
      if (width > 0) root.style.setProperty("--surface-w", `${width}px`);
    };

    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--surface-w");
    };
  }, [rootRef]);
}

import type { RefObject } from "react";
import { useLayoutEffect, useRef } from "react";

export type TickerScrollPhase = "process" | "text";

const SCROLL_SPEED = {
  process: 140,
  text: 100,
} satisfies Record<TickerScrollPhase, number>;

interface UseHorizontalTickerScrollOptions {
  viewportRef: RefObject<HTMLDivElement | null>;
  trackRef: RefObject<HTMLDivElement | null>;
  phase: TickerScrollPhase;
  pending?: boolean;
  error?: string;
}

/** Keeps ticker motion independent from event projection and item rendering. */
export function useHorizontalTickerScroll({
  viewportRef,
  trackRef,
  phase,
  pending,
  error,
}: UseHorizontalTickerScrollOptions): void {
  const speedRef = useRef(SCROLL_SPEED.process);
  const holdStartRef = useRef(false);
  const followLatestRef = useRef<() => void>(() => undefined);
  const previousPhaseRef = useRef<TickerScrollPhase | undefined>(undefined);
  const previousPendingRef = useRef(Boolean(pending));

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track) return;

    let frame: number | undefined;
    let lastTime: number | undefined;
    const step = (time: number) => {
      if (holdStartRef.current) {
        frame = undefined;
        lastTime = undefined;
        return;
      }
      if (lastTime === undefined) lastTime = time;
      const elapsed = Math.min(time - lastTime, 50);
      lastTime = time;
      const target = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      const distance = target - viewport.scrollLeft;
      if (Math.abs(distance) <= 1) {
        viewport.scrollLeft = target;
        frame = undefined;
        lastTime = undefined;
        return;
      }
      viewport.scrollLeft +=
        Math.sign(distance) * Math.min(Math.abs(distance), (speedRef.current * elapsed) / 1000);
      frame = requestAnimationFrame(step);
    };
    const followLatest = () => {
      if (holdStartRef.current) return;
      if (frame === undefined) {
        lastTime = undefined;
        frame = requestAnimationFrame(step);
      }
    };
    followLatestRef.current = followLatest;

    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(followLatest);
    observer?.observe(viewport);
    observer?.observe(track);
    window.addEventListener("resize", followLatest);
    followLatest();

    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", followLatest);
      followLatestRef.current = () => undefined;
    };
  }, [trackRef, viewportRef]);

  useLayoutEffect(() => {
    const enteringText = phase === "text" && previousPhaseRef.current !== "text";
    const finishing = previousPendingRef.current && !pending;
    speedRef.current = SCROLL_SPEED[phase];
    // 停跑只以运行结束为准（pending 翻转 = AI SDK finish/abort 收流的权威信号），
    // 不再从“最后一帧是不是文本”猜测：正常完成一律停在答案开头并挂起跟滚；
    // 错误流保持跟滚，让用户看到失败的完整过程。
    holdStartRef.current = !pending && !error;
    if ((enteringText || finishing) && !error && viewportRef.current) {
      viewportRef.current.scrollLeft = 0;
    }
    if (!holdStartRef.current) followLatestRef.current();
    previousPhaseRef.current = phase;
    previousPendingRef.current = Boolean(pending);
  }, [pending, phase, error, viewportRef]);

  useLayoutEffect(() => {
    followLatestRef.current();
  });
}

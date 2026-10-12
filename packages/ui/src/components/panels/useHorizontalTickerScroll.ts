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
}

/** Keeps ticker motion independent from event projection and item rendering. */
export function useHorizontalTickerScroll({
  viewportRef,
  trackRef,
  phase,
  pending,
}: UseHorizontalTickerScrollOptions): void {
  const speedRef = useRef(SCROLL_SPEED.process);
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
    const finishedText = phase === "text" && previousPendingRef.current && !pending;
    speedRef.current = SCROLL_SPEED[phase];
    if ((enteringText || finishedText) && viewportRef.current) {
      viewportRef.current.scrollLeft = 0;
    }
    followLatestRef.current();
    previousPhaseRef.current = phase;
    previousPendingRef.current = Boolean(pending);
  }, [pending, phase, viewportRef]);

  useLayoutEffect(() => {
    followLatestRef.current();
  });
}

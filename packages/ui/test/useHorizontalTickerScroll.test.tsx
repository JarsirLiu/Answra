import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type TickerScrollPhase,
  useHorizontalTickerScroll,
} from "../src/components/panels/useHorizontalTickerScroll";

let frameCallback: FrameRequestCallback | undefined;

function pumpFrame(time: number) {
  act(() => {
    const callback = frameCallback;
    frameCallback = undefined;
    callback?.(time);
  });
}

function stubViewport(viewport: HTMLElement, clientWidth: number, contentWidth: number) {
  let scrollLeft = 0;
  for (const [key, value] of [
    ["clientWidth", clientWidth],
    ["scrollWidth", clientWidth + contentWidth],
  ] as const) {
    Object.defineProperty(viewport, key, { configurable: true, get: () => value });
  }
  Object.defineProperty(viewport, "scrollLeft", {
    configurable: true,
    get: () => scrollLeft,
    set: (next: number) => {
      scrollLeft = next;
    },
  });
}

function TickerHarness({
  pending,
  phase,
  contentWidth,
}: {
  pending: boolean;
  phase: TickerScrollPhase;
  contentWidth: number;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  useHorizontalTickerScroll({ viewportRef, trackRef, phase, pending });
  return (
    <div className="viewport" ref={viewportRef}>
      <div className="track" ref={trackRef}>
        <span className="content">{"长".repeat(contentWidth)}</span>
      </div>
    </div>
  );
}

describe("useHorizontalTickerScroll", () => {
  beforeEach(() => {
    frameCallback = undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      frameCallback = undefined;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows the growing text toward the tail while pending", () => {
    const { container } = render(<TickerHarness pending phase="text" contentWidth={400} />);
    stubViewport(container.querySelector(".viewport") as HTMLElement, 100, 400);
    pumpFrame(0);
    pumpFrame(100);
    expect(
      Number((container.querySelector(".viewport") as HTMLElement).scrollLeft),
    ).toBeGreaterThan(0);
  });

  it("stops at the start of the answer once the reply finishes and ignores resize", () => {
    const { container, rerender } = render(
      <TickerHarness pending phase="text" contentWidth={400} />,
    );
    stubViewport(container.querySelector(".viewport") as HTMLElement, 100, 400);
    pumpFrame(0);
    pumpFrame(1000);
    expect(
      Number((container.querySelector(".viewport") as HTMLElement).scrollLeft),
    ).toBeGreaterThan(0);

    rerender(<TickerHarness pending={false} phase="text" contentWidth={400} />);
    const viewport = container.querySelector(".viewport") as HTMLElement;
    expect(viewport.scrollLeft).toBe(0);

    window.dispatchEvent(new Event("resize"));
    pumpFrame(1200);
    pumpFrame(1600);
    expect(viewport.scrollLeft).toBe(0);
  });

  it("holds the start when the done state mounts without any pending phase", () => {
    const { container } = render(<TickerHarness pending={false} phase="text" contentWidth={400} />);
    const viewport = container.querySelector(".viewport") as HTMLElement;
    stubViewport(viewport, 100, 400);
    pumpFrame(0);
    pumpFrame(2000);
    expect(viewport.scrollLeft).toBe(0);
  });

  it("keeps following the process activities after an error", () => {
    const { container, rerender } = render(
      <TickerHarness pending phase="process" contentWidth={400} />,
    );
    const viewport = container.querySelector(".viewport") as HTMLElement;
    stubViewport(viewport, 100, 400);
    pumpFrame(0);
    rerender(<TickerHarness pending={false} phase="process" contentWidth={400} />);
    pumpFrame(0);
    pumpFrame(1000);
    expect(Number(viewport.scrollLeft)).toBeGreaterThan(0);
  });
});

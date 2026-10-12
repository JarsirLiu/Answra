import type { ReplyBarActivity } from "@answra/shared";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplyActivityTicker } from "../src/components/panels/ReplyActivityTicker";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ReplyActivityTicker", () => {
  it("replays the completed answer horizontally when ResizeObserver is unavailable", () => {
    let nextFrameId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal("ResizeObserver", undefined);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return this.classList?.contains("reply-activity-viewport") ? 80 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get() {
        return this.classList?.contains("reply-activity-viewport") ? 480 : 0;
      },
    });

    const activities: ReplyBarActivity[] = [
      { id: "answer", kind: "text", label: "", text: "一段足够长的最终答案" },
    ];
    const view = render(
      <ReplyActivityTicker activities={activities} pending replyText="一段足够长的最终答案" />,
    );
    const viewport = screen.getByRole("log", { name: "模型回复活动" });
    expect(viewport.scrollLeft).toBe(0);

    view.rerender(
      <ReplyActivityTicker
        activities={activities}
        pending={false}
        replyText="一段足够长的最终答案"
      />,
    );
    expect(viewport.scrollLeft).toBe(0);

    act(() => {
      let time = 0;
      for (let frame = 0; frame < 12; frame += 1) {
        const [id, callback] = frames.entries().next().value ?? [];
        if (typeof id !== "number" || typeof callback !== "function") break;
        frames.delete(id);
        callback(time);
        time += 50;
      }
    });
    expect(viewport.scrollLeft).toBeGreaterThan(0);
    expect(viewport).toHaveAttribute("data-orientation", "horizontal");
    expect(screen.getByLabelText("当前事件：回答")).toBeInTheDocument();
    expect(screen.queryByText("回答")).not.toBeInTheDocument();
  });
});

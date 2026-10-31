import type { ReplyBarActivity } from "@answra/shared";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplyActivityTicker } from "../src/components/panels/ReplyActivityTicker";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ReplyActivityTicker", () => {
  it("holds the completed answer at the start when ResizeObserver is unavailable", () => {
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
    const view = render(<ReplyActivityTicker activities={activities} pending />);
    const viewport = screen.getByRole("log", { name: "模型回复活动" });
    expect(viewport.scrollLeft).toBe(0);

    // 流式期间：手动驱动 rAF，跑马灯跟随内容滚到尾部。
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

    // 完成：回到文本回复开头（答案在第一段）并挂起跟滚，即使没有 ResizeObserver 也不再前进。
    view.rerender(<ReplyActivityTicker activities={activities} pending={false} />);
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
    expect(viewport.scrollLeft).toBe(0);
    expect(viewport).toHaveAttribute("data-orientation", "horizontal");
    expect(screen.getByLabelText("当前事件：回答")).toBeInTheDocument();
    expect(screen.queryByText("回答")).not.toBeInTheDocument();
  });

  it("shows only the answer text when the run finishes with a tool or source tail", () => {
    const activities: ReplyBarActivity[] = [
      { id: "t1", kind: "text", label: "", text: "一段足够长的最终答案" },
      { id: "tool1", kind: "tool", label: "工具结果", text: "检索命中 3 条" },
    ];
    render(<ReplyActivityTicker activities={activities} pending={false} />);

    // 完成＝pending 翻转的权威信号：工具尾帧不把答案挤走，
    // 跟滚挂起后视口停在开头，用户第一眼看到的是答案起句。
    expect(screen.getByText("一段足够长的最终答案")).toBeInTheDocument();
    expect(screen.getByText("检索命中 3 条")).toBeInTheDocument();
    expect(screen.queryByText("正在等待模型输出…")).not.toBeInTheDocument();
  });

  it("does not fake a waiting state after the answer is finished", () => {
    render(<ReplyActivityTicker activities={[]} pending={false} />);

    expect(screen.getByText("模型未返回可展示内容")).toBeInTheDocument();
    expect(screen.queryByText("正在等待模型输出…")).not.toBeInTheDocument();
  });

  it("keeps the failure visible and following while an error is active", () => {
    const activities: ReplyBarActivity[] = [
      { id: "t1", kind: "text", label: "", text: "部分答案" },
      { id: "e1", kind: "error", label: "工具失败", text: "连接超时" },
    ];
    render(<ReplyActivityTicker activities={activities} error="连接超时" pending={false} />);

    // 错误流不清尾：失败上下文保持完整（现状行为，错误才允许跟滚）。
    expect(screen.getByText("连接超时")).toBeInTheDocument();
  });
});

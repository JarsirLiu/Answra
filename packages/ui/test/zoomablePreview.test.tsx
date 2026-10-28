import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ZoomablePreview } from "../src/components/panels/workspace/ZoomablePreview";

type ResizeCallback = (entries: unknown[]) => void;

/** 捕获 ResizeObserver 回调的桩：测试里手动触发视口尺寸变化。 */
let resizeCallback: ResizeCallback | undefined;

class CapturingResizeObserver implements ResizeObserver {
  constructor(callback: ResizeCallback) {
    resizeCallback = callback;
  }
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

function stubAvailableWidth(width: number) {
  const viewport = document.querySelector<HTMLDivElement>(".zoomable-preview__viewport");
  if (!viewport) throw new Error("zoomable preview 未渲染");
  return vi.spyOn(viewport, "clientWidth", "get").mockReturnValue(width);
}

function fireViewportResize() {
  act(() => {
    resizeCallback?.([]);
  });
}

describe("ZoomablePreview", () => {
  it("视口宽度变化时按自然宽度重适应，结果确定且可重复", () => {
    vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
    render(
      <ZoomablePreview fitSignal={1} fitWidthPx={250}>
        <div>内容</div>
      </ZoomablePreview>,
    );
    expect(screen.getByText("100%")).toBeInTheDocument();

    const spy = stubAvailableWidth(500);
    fireViewportResize();
    expect(screen.getByText("200%")).toBeInTheDocument();
    // 同一宽度反复触发不得漂移；轻微宽度变化也只在 1% 网格上变化（向下取整）。
    fireViewportResize();
    expect(screen.getByText("200%")).toBeInTheDocument();
    spy.mockReturnValue(501);
    fireViewportResize();
    expect(screen.getByText("200%")).toBeInTheDocument();
    spy.mockReturnValue(500);
    fireViewportResize();
    expect(screen.getByText("200%")).toBeInTheDocument();
    spy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("手动缩放后视口变化不再重适应，点「适应宽度」恢复跟随", () => {
    vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
    render(
      <ZoomablePreview fitSignal={1} fitWidthPx={250}>
        <div>内容</div>
      </ZoomablePreview>,
    );

    const spy = stubAvailableWidth(500);
    fireViewportResize();
    expect(screen.getByText("200%")).toBeInTheDocument();

    // 手动放大一档：进入手动模式，resize 不再改 zoom。
    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(screen.getByText("210%")).toBeInTheDocument();
    fireViewportResize();
    expect(screen.getByText("210%")).toBeInTheDocument();

    // 点「适应宽度」恢复自动跟随。
    fireEvent.click(screen.getByRole("button", { name: "适应宽度" }));
    expect(screen.getByText("200%")).toBeInTheDocument();
    spy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("无自然宽度（自动折行内容）时适应宽度回到 100%", () => {
    vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
    render(
      <ZoomablePreview fitSignal={1}>
        <div>内容</div>
      </ZoomablePreview>,
    );

    const spy = stubAvailableWidth(500);
    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(screen.getByText("110%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "适应宽度" }));
    expect(screen.getByText("100%")).toBeInTheDocument();
    spy.mockRestore();
    vi.unstubAllGlobals();
  });
});

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tooltip, TooltipProvider } from "../src/components/controls/Tooltip";

function renderTooltip(stealth: boolean) {
  return render(
    <TooltipProvider stealth={stealth}>
      <Tooltip label="全部已读">
        <button aria-label="测试按钮" type="button">
          图标
        </button>
      </Tooltip>
    </TooltipProvider>,
  );
}

describe("Tooltip（隐身门控自制气泡）", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the glyph bubble after the hover delay outside stealth", () => {
    vi.useFakeTimers();
    renderTooltip(false);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "测试按钮" }));
    expect(screen.queryByText("全部已读")).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText("全部已读")).toBeInTheDocument();
  });

  it("keeps stealth completely silent and leaks no native title", () => {
    vi.useFakeTimers();
    renderTooltip(true);
    const trigger = screen.getByRole("button", { name: "测试按钮" });

    fireEvent.mouseEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText("全部已读")).not.toBeInTheDocument();
    expect(trigger).not.toHaveAttribute("title");
  });

  it("fails closed when no provider is above", () => {
    vi.useFakeTimers();
    render(
      <Tooltip label="全部已读">
        <button aria-label="测试按钮" type="button" />
      </Tooltip>,
    );

    fireEvent.mouseEnter(screen.getByRole("button", { name: "测试按钮" }));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText("全部已读")).not.toBeInTheDocument();
  });

  it("retracts an in-flight glyph the moment stealth turns on", () => {
    vi.useFakeTimers();
    const first = renderTooltip(false);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "测试按钮" }));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText("全部已读")).toBeInTheDocument();

    first.rerender(
      <TooltipProvider stealth>
        <Tooltip label="全部已读">
          <button aria-label="测试按钮" type="button">
            图标
          </button>
        </Tooltip>
      </TooltipProvider>,
    );
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(screen.queryByText("全部已读")).not.toBeInTheDocument();
  });

  it("retracts on mouse leave and focus loss", () => {
    vi.useFakeTimers();
    renderTooltip(false);
    const trigger = screen.getByRole("button", { name: "测试按钮" });

    fireEvent.mouseEnter(trigger);
    fireEvent.mouseLeave(trigger);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText("全部已读")).not.toBeInTheDocument();

    fireEvent.focus(trigger);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText("全部已读")).toBeInTheDocument();
    fireEvent.blur(trigger);
    expect(screen.queryByText("全部已读")).not.toBeInTheDocument();
  });
});

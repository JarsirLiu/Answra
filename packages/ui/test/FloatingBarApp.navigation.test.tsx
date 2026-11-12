import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { FloatingBarApp } from "../src/app/FloatingBarApp";
import { ICON } from "../src/tokens";
import { resetFloatingBarTestState } from "./support/floatingBarHarness";

describe("floating bar navigation and shell", () => {
  beforeEach(resetFloatingBarTestState);

  it("changes the middle feature group when the work mode changes", () => {
    render(<FloatingBarApp />);

    // 启动默认收起：只显示悬浮导航条，对话面板需用户主动打开。
    expect(screen.queryByRole("heading", { name: "AI 对话" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开对话" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "对话" }));
    expect(screen.getByRole("menuitemradio", { name: "对话" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "答题" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "面试" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio", { name: "会议" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "答题" }));
    expect(screen.getByRole("button", { name: "截图提问" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开对话" })).not.toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "会议助手（即将推出）" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开设置" })).toBeInTheDocument();
  });

  it("keeps a single notebook entry and one icon size across the nav bar", () => {
    render(<FloatingBarApp />);

    expect(screen.getAllByRole("button", { name: "打开笔记本" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "打开参考资料" })).not.toBeInTheDocument();

    const bar = document.querySelector(".floating-bar") as HTMLElement;
    const glyphs = [...bar.querySelectorAll("button svg")].filter(
      (glyph) =>
        !glyph.classList.contains("mode-picker-chevron") &&
        !glyph.classList.contains("destination-chevron"),
    );
    expect(glyphs).toHaveLength(5);
    for (const glyph of glyphs) {
      expect(glyph.getAttribute("width")).toBe(String(ICON));
      expect(glyph.getAttribute("height")).toBe(String(ICON));
    }
  });

  it("uses a conversation icon for the chat entry and a voice icon for the interview mode", () => {
    render(<FloatingBarApp />);

    const chatEntry = screen.getByRole("button", { name: "打开对话" });
    expect(chatEntry.querySelector("svg")?.classList.contains("lucide-messages-square")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "对话" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "面试" }));
    const modeTrigger = screen.getByRole("button", { name: "面试" });
    expect(modeTrigger.querySelector("svg")?.classList.contains("lucide-audio-lines")).toBe(true);
    expect(screen.getByRole("region", { name: "面试分身" })).toBeInTheDocument();
  });

  it("renders every mode action as a plain icon button without a stuck tint", () => {
    render(<FloatingBarApp />);

    const classes = [...document.querySelectorAll(".feature-action")].map(
      (action) => action.className,
    );
    expect(classes).toHaveLength(1);
    expect(new Set(classes).size).toBe(1);
    expect(classes.every((name) => name.includes("surface-control--default"))).toBe(true);
    expect(classes.some((name) => name.includes("primary"))).toBe(false);
  });

  it("overlays the mode menu on an open panel instead of pushing it down", () => {
    render(<FloatingBarApp />);
    fireEvent.click(screen.getByRole("button", { name: "打开笔记本" }));
    fireEvent.click(screen.getByRole("button", { name: "对话" }));

    // 面板已打开：外壳不得为菜单预留高度，否则窗口变高、面板被下推
    const stack = document.querySelector(".floating-bar-stack");
    expect(stack).not.toHaveClass("is-menu-open");
  });

  it("includes the expanded mode menu in the measured window layout", () => {
    render(<FloatingBarApp />);
    // 启动即收起：菜单直接进入布局流，为窗口预留真实高度。
    fireEvent.click(screen.getByRole("button", { name: "对话" }));

    const menu = screen.getByRole("menu", { name: "工作模式" });
    expect(menu.parentElement).toHaveClass("is-menu-in-flow");
    expect(screen.queryByRole("menuitemradio", { name: "会议" })).not.toBeInTheDocument();
  });

  it("shows the mode menu as a dismissible layer without replacing the open panel", async () => {
    render(<FloatingBarApp />);
    fireEvent.click(screen.getByRole("button", { name: "打开笔记本" }));
    fireEvent.click(screen.getByRole("button", { name: "对话" }));

    expect(
      await screen.findByRole("heading", { name: "笔记本 / 资料" }, { timeout: 10_000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "工作模式" })).toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "工作模式" }).parentElement).not.toHaveClass(
      "is-menu-in-flow",
    );
    expect(screen.queryByRole("menuitemradio", { name: "会议" })).not.toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "工作模式" })).not.toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "笔记本 / 资料" }, { timeout: 10_000 }),
    ).toBeInTheDocument();
  });

  it("opens the workspace panel with directory pick entry and opens settings from the third segment", () => {
    render(<FloatingBarApp />);
    fireEvent.click(screen.getByRole("button", { name: "打开笔记本" }));
    expect(screen.getByRole("button", { name: /选择目录/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    // Tab 栏即面板头部：无"设置"标题行
    expect(screen.queryByRole("heading", { name: "设置" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "设置" })).toHaveAttribute("aria-selected", "true");
  });

  it("reports shell content size through the bridge and closes on demand", () => {
    const bridge = { fitContent: vi.fn(), close: vi.fn() };
    render(<FloatingBarApp bridge={bridge} />);

    fireEvent.click(screen.getByRole("button", { name: "打开笔记本" }));
    expect(screen.getByRole("heading", { name: "笔记本 / 资料" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起面板" }));
    expect(screen.queryByRole("heading", { name: "笔记本 / 资料" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭应用" }));
    expect(bridge.close).toHaveBeenCalled();
  });
});

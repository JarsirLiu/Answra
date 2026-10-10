import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingBarApp } from "../src/app/FloatingBarApp";

describe("three-segment floating navigation", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("changes the middle feature group when the work mode changes", () => {
    render(<FloatingBarApp />);

    expect(screen.getByRole("button", { name: "截图提问" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "笔试" }));
    expect(screen.getByRole("menuitemradio", { name: "笔试" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "面试" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "会议" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "面试" }));
    expect(screen.getByRole("button", { name: "AI 建议（即将推出）" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "截图提问" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "面试" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "会议" }));
    expect(screen.getByRole("button", { name: "会议记录" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开设置" })).toBeInTheDocument();
  });

  it("attaches a screenshot, accepts a follow-up prompt, and sends both together", () => {
    const { container } = render(<FloatingBarApp />);
    fireEvent.click(screen.getByRole("button", { name: "截图提问" }));
    const fileInput = container.querySelector<HTMLInputElement>('input[aria-label="选择截图图片"]');
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput as HTMLInputElement, {
      target: { files: [new File(["image"], "question.png", { type: "image/png" })] },
    });

    expect(screen.getByAltText("待发送截图预览")).toBeInTheDocument();
    const prompt = screen.getByRole("textbox", { name: "补充问题" });
    fireEvent.change(prompt, { target: { value: "请解释这道题的边界条件" } });
    fireEvent.click(screen.getByRole("button", { name: "发送给 AI" }));

    expect(screen.getByText("请解释这道题的边界条件")).toBeInTheDocument();
    expect(screen.getByAltText("用户添加的截图：question.png")).toBeInTheDocument();
    expect(screen.getByText(/当前尚未连接 AI 服务/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送给 AI" })).toBeDisabled();
  });

  it("saves notebook text locally and opens settings from the third segment", () => {
    render(<FloatingBarApp />);
    fireEvent.click(screen.getByRole("button", { name: "打开笔记本" }));
    fireEvent.change(screen.getByRole("textbox", { name: "个人笔记" }), {
      target: { value: "先确认输入约束" },
    });
    expect(localStorage.getItem("exam-assistant-note")).toBe("先确认输入约束");

    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    expect(screen.getByRole("heading", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByText("尚未连接")).toBeInTheDocument();
  });

  it("forwards mode switches and close through the desktop bridge", () => {
    const bridge = { setMode: vi.fn(), close: vi.fn() };
    render(<FloatingBarApp bridge={bridge} />);

    fireEvent.click(screen.getByRole("button", { name: "打开笔记本" }));
    expect(bridge.setMode).toHaveBeenCalledWith("notes");
    fireEvent.click(screen.getByRole("button", { name: "收起面板" }));
    expect(bridge.setMode).toHaveBeenCalledWith("closed");
    fireEvent.click(screen.getByRole("button", { name: "关闭应用" }));
    expect(bridge.close).toHaveBeenCalled();
  });
});

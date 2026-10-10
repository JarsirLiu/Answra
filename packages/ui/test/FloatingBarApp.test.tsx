import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingBarApp } from "../src/app/FloatingBarApp";

describe("three-segment floating navigation", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    delete document.documentElement.dataset.theme;
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

  it("captures a region screenshot through the bridge and attaches it to the chat", async () => {
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      startRegionCapture: vi.fn().mockResolvedValue({
        dataUrl: "data:image/png;base64,QUJD",
        height: 200,
        ok: true,
        width: 300,
      }),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "截图提问" }));

    await waitFor(() => expect(screen.getByAltText("待发送截图预览")).toBeInTheDocument());
    expect(bridge.startRegionCapture).toHaveBeenCalledTimes(1);
    expect(screen.getByAltText("待发送截图预览")).toHaveAttribute(
      "src",
      "data:image/png;base64,QUJD",
    );
    // 成功后自动填入默认分析提示语
    expect(screen.getByRole("textbox", { name: "补充问题" })).toHaveValue(
      "请帮我分析这道题，先说明题意和解题思路。",
    );
  });

  it("keeps the chat empty when the user cancels the region capture", async () => {
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      startRegionCapture: vi.fn().mockResolvedValue({ ok: false, reason: "cancelled" }),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "截图提问" }));

    await waitFor(() => expect(bridge.startRegionCapture).toHaveBeenCalledTimes(1));
    expect(screen.queryByAltText("待发送截图预览")).not.toBeInTheDocument();
  });

  it("saves notebook text locally and opens settings from the third segment", () => {
    render(<FloatingBarApp />);
    fireEvent.click(screen.getByRole("button", { name: "打开笔记本" }));
    fireEvent.change(screen.getByRole("textbox", { name: "个人笔记" }), {
      target: { value: "先确认输入约束" },
    });
    expect(localStorage.getItem("answra-note")).toBe("先确认输入约束");

    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    expect(screen.getByRole("heading", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByText("尚未连接")).toBeInTheDocument();
  });

  it("toggles ambient background following in settings and persists the choice", () => {
    render(<FloatingBarApp />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    const toggle = screen.getByRole("checkbox", { name: /跟随背景色/ });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(localStorage.getItem("answra-ambient-follow")).toBe("on");

    fireEvent.click(toggle);
    expect(localStorage.getItem("answra-ambient-follow")).toBe("off");
  });

  it("adjusts global opacity from settings and persists the choice", () => {
    render(<FloatingBarApp />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    const slider = screen.getByRole("slider", { name: "整体透明度" });
    // 缺省不透明（1）：0.8 会把面板玻璃 alpha 压到发灰，可读性靠 blur 承担
    expect(slider).toHaveValue("1");

    fireEvent.change(slider, { target: { value: "0.6" } });
    expect(slider).toHaveValue("0.6");
    // fade 写在 :root（感知令牌在 :root 声明并求值），驱动全部令牌同步缩放
    expect(document.documentElement.style.getPropertyValue("--fade")).toBe("0.6");
    expect(localStorage.getItem("answra-opacity")).toBe("0.6");
  });

  it("switches color scheme via the segmented control and persists the choice", () => {
    render(<FloatingBarApp />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    const group = screen.getByRole("radiogroup", { name: "外观模式" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "跟随系统" })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("radio", { name: "深色" }));
    expect(screen.getByRole("radio", { name: "深色" })).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("answra-color-scheme")).toBe("dark");
  });

  it("toggles meeting stealth in settings, persists the choice, and notifies the bridge", async () => {
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      getStealthSupport: vi.fn().mockResolvedValue(true),
      setStealth: vi.fn(),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    const toggle = screen.getByRole("checkbox", { name: /会议隐身/ });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(localStorage.getItem("answra-stealth")).toBe("on");
    await waitFor(() => expect(bridge.setStealth).toHaveBeenCalledWith(true));

    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(localStorage.getItem("answra-stealth")).toBe("off");
    await waitFor(() => expect(bridge.setStealth).toHaveBeenCalledWith(false));
  });

  it("disables meeting stealth when the system does not support content protection", async () => {
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      getStealthSupport: vi.fn().mockResolvedValue(false),
      setStealth: vi.fn(),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    const toggle = screen.getByRole("checkbox", { name: /会议隐身/ });
    await waitFor(() => expect(toggle).toBeDisabled());
    expect(screen.getByText(/当前系统不支持/)).toBeInTheDocument();
    // 能力未确认/不支持时，绝不向主进程发送隐身指令
    expect(bridge.setStealth).not.toHaveBeenCalled();
  });

  it("reports shell content size through the bridge and closes on demand", () => {
    const bridge = { fitContent: vi.fn(), close: vi.fn() };
    render(<FloatingBarApp bridge={bridge} />);

    fireEvent.click(screen.getByRole("button", { name: "打开笔记本" }));
    expect(screen.getByRole("heading", { name: "笔记本" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起面板" }));
    expect(screen.queryByRole("heading", { name: "笔记本" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭应用" }));
    expect(bridge.close).toHaveBeenCalled();
  });
});

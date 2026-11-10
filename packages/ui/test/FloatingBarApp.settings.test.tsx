import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingBarApp } from "../src/app/FloatingBarApp";
import { createConversationBridge, resetFloatingBarTestState } from "./support/floatingBarHarness";

describe("floating bar settings", () => {
  beforeEach(resetFloatingBarTestState);

  it("toggles ambient background following in settings and persists the choice", () => {
    render(<FloatingBarApp />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    const toggle = screen.getByRole("checkbox", { name: /跟随背景色/ });
    expect(toggle).not.toBeChecked();
    expect(toggle).not.toBeDisabled();

    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(localStorage.getItem("answra-ambient-follow")).toBe("on");

    fireEvent.click(toggle);
    expect(localStorage.getItem("answra-ambient-follow")).toBe("off");
  });

  it("does not offer the removed chameleon veil levels in settings", () => {
    render(<FloatingBarApp />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    // 「隐蔽强度」四档已移除：文字不再按对比度求解，避免灰雾字
    expect(screen.queryByRole("button", { name: "隐蔽" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "贴合" })).not.toBeInTheDocument();
    // 前景透明度仍在：它是唯一的前景淡化自由度
    expect(screen.getByRole("slider", { name: "前景透明度" })).toBeInTheDocument();
  });

  it("offers local model configuration in development and switches to cloud subscription", async () => {
    const bridge = {
      ...createConversationBridge(),
      getConversationConfig: vi.fn().mockResolvedValue({
        source: "local",
        localAvailable: true,
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "local-model",
        answerModel: "",
        configured: true,
      }),
      getConversationApiKey: vi.fn().mockResolvedValue({ apiKey: "secret-key" }),
      configureConversation: vi.fn().mockImplementation(async (settings) => ({
        source: settings.source,
        localAvailable: true,
        baseUrl: settings.baseUrl,
        model: settings.model,
        answerModel: settings.answerModel ?? "",
        configured: Boolean(settings.baseUrl && settings.model),
      })),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    // 「设置」页先常规后模型：高频开关在更易触达的上方
    await screen.findByRole("heading", { name: "模型" });
    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "常规",
      "模型",
    ]);
    expect(screen.getByPlaceholderText("http://127.0.0.1:1234/v1")).toHaveValue(
      "http://127.0.0.1:1234/v1",
    );
    expect(screen.getByPlaceholderText("必填")).toHaveValue("local-model");
    expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "云端订阅" }));
    expect(screen.queryByPlaceholderText("http://127.0.0.1:1234/v1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "本地模型" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(bridge.configureConversation).toHaveBeenCalledWith(
        expect.objectContaining({ source: "local", model: "local-model" }),
      ),
    );
  });

  it("hides local model configuration in packaged builds", async () => {
    const bridge = {
      ...createConversationBridge(),
      getConversationConfig: vi.fn().mockResolvedValue({
        source: "cloud",
        localAvailable: false,
        baseUrl: "",
        model: "",
        answerModel: "",
        configured: false,
      }),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    // 打包版整块「模型」分组不渲染，不留空壳标题
    await screen.findByRole("heading", { name: "常规" });
    expect(screen.queryByRole("heading", { name: "模型" })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("http://127.0.0.1:1234/v1")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
  });

  it("keeps ambient and stealth settings independent", async () => {
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      getStealthSupport: vi.fn().mockResolvedValue(true),
      setAmbientFollow: vi.fn(),
      setStealth: vi.fn(),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    const ambientToggle = screen.getByRole("checkbox", { name: "跟随背景色" });
    const stealthToggle = screen.getByRole("checkbox", { name: "会议隐身" });
    await waitFor(() => expect(stealthToggle).not.toBeDisabled());
    bridge.setAmbientFollow.mockClear();
    bridge.setStealth.mockClear();

    fireEvent.click(ambientToggle);
    expect(ambientToggle).toBeChecked();
    expect(stealthToggle).not.toBeChecked();
    expect(localStorage.getItem("answra-ambient-follow")).toBe("on");
    expect(localStorage.getItem("answra-stealth")).toBeNull();
    expect(bridge.setStealth).not.toHaveBeenCalledWith(true);
    await waitFor(() => expect(bridge.setAmbientFollow).toHaveBeenCalledWith(true));

    fireEvent.click(stealthToggle);
    expect(stealthToggle).toBeChecked();
    expect(ambientToggle).toBeChecked();
    expect(localStorage.getItem("answra-stealth")).toBe("on");
    expect(localStorage.getItem("answra-ambient-follow")).toBe("on");
    expect(bridge.setAmbientFollow).toHaveBeenCalledWith(true);
    await waitFor(() => expect(bridge.setStealth).toHaveBeenCalledWith(true));
  });

  it("adjusts global opacity from settings and persists the choice", () => {
    render(<FloatingBarApp />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    const slider = screen.getByRole("slider", { name: "前景透明度" });
    // 缺省不透明（1）：0.8 会把面板玻璃 alpha 压到发灰，可读性靠 blur 承担
    expect(slider).toHaveValue("1");

    fireEvent.change(slider, { target: { value: "0.6" } });
    expect(slider).toHaveValue("0.6");
    // fade 写在 :root（感知令牌在 :root 声明并求值），驱动全部令牌同步缩放
    expect(document.documentElement.style.getPropertyValue("--fade")).toBe("0.6");
    expect(localStorage.getItem("answra-opacity")).toBe("0.6");
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
    expect(document.querySelector(".overlay-root")).not.toHaveAttribute("data-stealth");
    expect(document.documentElement).not.toHaveAttribute("data-stealth");

    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(document.querySelector(".overlay-root")).toHaveAttribute("data-stealth", "true");
    expect(document.documentElement).toHaveAttribute("data-stealth", "true");
    expect(localStorage.getItem("answra-stealth")).toBe("on");
    await waitFor(() => expect(bridge.setStealth).toHaveBeenCalledWith(true));

    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(document.querySelector(".overlay-root")).not.toHaveAttribute("data-stealth");
    expect(document.documentElement).not.toHaveAttribute("data-stealth");
    expect(localStorage.getItem("answra-stealth")).toBe("off");
    await waitFor(() => expect(bridge.setStealth).toHaveBeenCalledWith(false));
  });

  it("enables meeting stealth by default in packaged builds unless the user turned it off", async () => {
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      getStealthSupport: vi.fn().mockResolvedValue(true),
      isPackaged: true,
      setStealth: vi.fn(),
    };
    const { unmount } = render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    const toggle = screen.getByRole("checkbox", { name: "会议隐身" });
    expect(toggle).toBeChecked();
    expect(document.documentElement).toHaveAttribute("data-stealth", "true");
    expect(localStorage.getItem("answra-stealth")).toBeNull();
    await waitFor(() => expect(bridge.setStealth).toHaveBeenCalledWith(true));

    unmount();
    localStorage.setItem("answra-stealth", "off");
    const secondBridge = { ...bridge, setStealth: vi.fn() };
    render(<FloatingBarApp bridge={secondBridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    expect(screen.getByRole("checkbox", { name: "会议隐身" })).not.toBeChecked();
    expect(document.documentElement).not.toHaveAttribute("data-stealth");
    await waitFor(() => expect(secondBridge.setStealth).toHaveBeenCalledWith(false));
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
    // 不支持时不向主进程发送隐身指令
    expect(bridge.setStealth).not.toHaveBeenCalled();
  });

  it("treats a failed stealth capability query as unsupported", async () => {
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      getStealthSupport: vi.fn().mockRejectedValue(new Error("IPC unavailable")),
      setStealth: vi.fn(),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    await waitFor(() => expect(screen.getByRole("checkbox", { name: /会议隐身/ })).toBeDisabled());
    expect(bridge.setStealth).not.toHaveBeenCalledWith(true);
    expect(bridge.setStealth).not.toHaveBeenCalled();
  });

  it("allows disabling a persisted stealth state when support detection fails", async () => {
    localStorage.setItem("answra-stealth", "on");
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      getStealthSupport: vi.fn().mockRejectedValue(new Error("IPC unavailable")),
      setStealth: vi.fn(),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    const toggle = screen.getByRole("checkbox", { name: "会议隐身" });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(localStorage.getItem("answra-stealth")).toBe("off");
    await waitFor(() => expect(bridge.setStealth).toHaveBeenCalledWith(false));
  });
});

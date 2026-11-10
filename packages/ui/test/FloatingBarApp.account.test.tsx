import type { AuthStatus } from "@answra/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingBarApp } from "../src/app/FloatingBarApp";
import { createConversationBridge, resetFloatingBarTestState } from "./support/floatingBarHarness";

describe("floating bar account", () => {
  beforeEach(resetFloatingBarTestState);

  it("hides the account block when the bridge exposes no auth API", () => {
    render(<FloatingBarApp bridge={{ fitContent: vi.fn(), close: vi.fn() }} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    // 无账户能力时连「账户」入口都不出现，避免留下空壳 Tab。
    expect(screen.queryByRole("tab", { name: "账户" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "账户" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "登录" })).not.toBeInTheDocument();
  });

  it("starts sign-in from settings and tells the user to finish in the browser", async () => {
    const loginAccount = vi.fn().mockResolvedValue({ opened: true });
    const bridge = {
      ...createConversationBridge(),
      getAuthStatus: vi
        .fn()
        .mockResolvedValue({ signedIn: false, plan: null, capabilities: [], cloudBaseUrl: null }),
      onAuthStatus: vi.fn(() => () => undefined),
      loginAccount,
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    fireEvent.click(screen.getByRole("tab", { name: "账户" }));

    await waitFor(() => expect(screen.getByText("未登录")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(loginAccount).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByText("已在浏览器中打开授权页，完成后会自动同步")).toBeInTheDocument(),
    );
  });

  it("shows a login failure instead of the browser hint", async () => {
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      getAuthStatus: vi
        .fn()
        .mockResolvedValue({ signedIn: false, plan: null, capabilities: [], cloudBaseUrl: null }),
      onAuthStatus: vi.fn(() => () => undefined),
      loginAccount: vi.fn().mockResolvedValue({ opened: false, error: "无法打开授权页" }),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    fireEvent.click(screen.getByRole("tab", { name: "账户" }));

    fireEvent.click(await screen.findByRole("button", { name: "登录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法打开授权页");
  });

  it("stays signed-in without quota data and returns to signed-out after a logout push", async () => {
    let listener: ((status: AuthStatus) => void) | undefined;
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      getAuthStatus: vi.fn().mockResolvedValue({
        signedIn: true,
        plan: "pro",
        capabilities: ["text.chat", "voice.interview"],
        cloudBaseUrl: "https://api.answra.com",
      }),
      onAuthStatus: vi.fn((next: (status: AuthStatus) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      }),
      logoutAccount: vi.fn(),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    fireEvent.click(screen.getByRole("tab", { name: "账户" }));

    expect(await screen.findByText("已登录")).toBeInTheDocument();
    // 能力目录是「已实现的接口面」，不渲染成「已解锁 N 项能力」，避免把目录当额度。
    expect(screen.queryByText(/已解锁/)).not.toBeInTheDocument();
    // 档位徽章只由服务端额度摘要（quota）承载；旧快照无额度数据时不猜档位语义。
    expect(screen.queryByText("会员")).not.toBeInTheDocument();
    expect(screen.queryByText("本月额度")).not.toBeInTheDocument();
    expect(screen.queryByText("套餐")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退出登录" })).toBeInTheDocument();

    // 主进程推送登出（例如凭据失效）后，界面回到未登录。
    act(() => {
      listener?.({ signedIn: false, plan: null, capabilities: [], cloudBaseUrl: null });
    });
    expect(await screen.findByText("未登录")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
  });

  it("shows the signed-in account identity and available subscription credits", async () => {
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      getAuthStatus: vi.fn().mockResolvedValue({
        signedIn: true,
        plan: "pro",
        account: { email: "admin@answra.local", username: "admin" },
        quota: {
          kind: "subscription",
          planName: "标准版",
          availableCredits: 50,
          usedCredits: 30,
          totalCredits: 80,
          usedPercent: 37.5,
          expiresAt: "2026-12-01T00:00:00Z",
          daysRemaining: 42,
        },
        capabilities: [],
        cloudBaseUrl: "https://api.answra.com",
      }),
      onAuthStatus: vi.fn(() => () => undefined),
      logoutAccount: vi.fn(),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    fireEvent.click(screen.getByRole("tab", { name: "账户" }));

    expect(await screen.findByText("admin@answra.local")).toBeInTheDocument();
    expect(screen.getByText("标准版")).toBeInTheDocument();
    // 档位由徽章表达，「套餐」行不再重复出现。
    expect(screen.queryByText("套餐")).not.toBeInTheDocument();
    expect(screen.getByText("50 积分")).toBeInTheDocument();
    // 可用积分是额度卡主行：标签在左、数值在右。
    expect(screen.getByText("可用积分")).toBeInTheDocument();
    expect(screen.getByText("剩余 42 天")).toBeInTheDocument();
    expect(screen.getByText("本周期已用")).toBeInTheDocument();
    expect(screen.getByText("30 / 80 积分")).toBeInTheDocument();
    const meter = screen.getByRole("progressbar", { name: "本月额度用量" });
    expect(meter).toHaveAttribute("aria-valuenow", "38");
    // 有额度数据时不出现「未开通套餐」占位。
    expect(screen.queryByText("未开通套餐")).not.toBeInTheDocument();
  });

  it("shows free users' available credits and welfare expiry without exposing balance", async () => {
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      getAuthStatus: vi.fn().mockResolvedValue({
        signedIn: true,
        plan: "default",
        account: { email: "free@answra.local", username: "free" },
        quota: {
          kind: "default",
          planName: "免费版",
          availableCredits: 18,
          welfareCredits: 10,
          accountCredits: 8,
          welfareExpiresAt: "2026-11-01T00:00:00Z",
          usedPercent: null,
          expiresAt: null,
          daysRemaining: null,
        },
        capabilities: ["text.chat"],
        cloudBaseUrl: "https://api.answra.com",
      }),
      onAuthStatus: vi.fn(() => () => undefined),
      logoutAccount: vi.fn(),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    fireEvent.click(screen.getByRole("tab", { name: "账户" }));

    expect(await screen.findByText("免费版")).toBeInTheDocument();
    expect(screen.getByText("18 积分")).toBeInTheDocument();
    expect(screen.getByText("福利积分")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("账户额度")).toBeInTheDocument();
    expect(screen.getByText("8")).toBeInTheDocument();
    expect(screen.getByText("福利到期")).toBeInTheDocument();
    expect(screen.queryByText(/¥|余额/)).not.toBeInTheDocument();
  });

  it("signs out from settings and adopts the returned status", async () => {
    const logoutAccount = vi.fn().mockResolvedValue({
      signedIn: false,
      plan: null,
      capabilities: [],
      cloudBaseUrl: null,
    });
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      getAuthStatus: vi.fn().mockResolvedValue({
        signedIn: true,
        plan: "pro",
        capabilities: ["text.chat"],
        cloudBaseUrl: "https://api.answra.com",
      }),
      onAuthStatus: vi.fn(() => () => undefined),
      logoutAccount,
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    fireEvent.click(screen.getByRole("tab", { name: "账户" }));

    fireEvent.click(await screen.findByRole("button", { name: "退出登录" }));
    expect(logoutAccount).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("未登录")).toBeInTheDocument();
  });

  it("stops listening for auth pushes when the panel closes", async () => {
    const unsubscribe = vi.fn();
    const bridge = {
      ...createConversationBridge(),
      getAuthStatus: vi
        .fn()
        .mockResolvedValue({ signedIn: false, plan: null, capabilities: [], cloudBaseUrl: null }),
      onAuthStatus: vi.fn(() => unsubscribe),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    const collapse = screen.getByRole("button", { name: "收起面板" });
    fireEvent.click(collapse);

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

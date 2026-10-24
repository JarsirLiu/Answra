import type { DesktopAnnouncement } from "@answra/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "../src/components/panels/SettingsPanel";

const announcements: DesktopAnnouncement[] = [
  {
    id: 1,
    title: "系统升级",
    content: "明天凌晨升级。",
    notifyMode: "silent",
    readAt: null,
    createdAt: "2026-10-19T09:00:00Z",
  },
];

function baseProps(overrides: Partial<Parameters<typeof SettingsPanel>[0]> = {}) {
  return {
    ambientFollow: false,
    opacity: 1,
    stealth: false,
    stealthSupported: true,
    onAmbientFollowChange: vi.fn(),
    onOpacityChange: vi.fn(),
    onStealthChange: vi.fn(),
    announcements,
    unreadAnnouncements: announcements.filter((item) => !item.readAt).length,
    signedIn: true,
    onMarkAnnouncementRead: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    ...overrides,
  } satisfies Parameters<typeof SettingsPanel>[0];
}

const authBridge = {
  fitContent: vi.fn(),
  close: vi.fn(),
  getAuthStatus: vi.fn().mockResolvedValue({
    signedIn: false,
    plan: null,
    capabilities: [],
    cloudBaseUrl: null,
  }),
};

/** 已登录桥：账户页徽章与额度都来自服务端额度摘要（quota），档位名原样下发。 */
function signedInBridge(quota: unknown) {
  return {
    fitContent: vi.fn(),
    close: vi.fn(),
    getAuthStatus: vi.fn().mockResolvedValue({
      signedIn: true,
      plan: null,
      account: { email: "user@answra.local", username: null },
      quota,
      capabilities: [],
      cloudBaseUrl: "https://api.answra.com",
    }),
    onAuthStatus: vi.fn(() => () => undefined),
    logoutAccount: vi.fn(),
  };
}

describe("SettingsPanel tabs", () => {
  it("opens on the settings page and hides the account entry without an auth bridge", () => {
    render(<SettingsPanel {...baseProps()} />);

    // Tab 栏即面板头部：不再有"设置"标题行，激活页靠 aria-selected 表达
    expect(screen.getByRole("tab", { name: "设置" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("heading", { name: "设置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "账户" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "登录" })).not.toBeInTheDocument();
  });

  it("switches to the account page when the app provides account capability", async () => {
    render(
      <SettingsPanel
        {...baseProps({
          bridge: authBridge,
          signedIn: false,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "账户" }));

    expect(screen.getByRole("tab", { name: "账户" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("未登录")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
  });

  it("switches between the account and settings pages without losing the tab bar", () => {
    render(<SettingsPanel {...baseProps({ bridge: authBridge })} />);

    fireEvent.click(screen.getByRole("tab", { name: "账户" }));
    expect(screen.getByText("未登录")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "设置" }));
    expect(screen.getByRole("tab", { name: "设置" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "常规" })).toBeInTheDocument();
  });

  it("shows the server-issued plan name as a membership badge and drops the redundant plan row", async () => {
    render(
      <SettingsPanel
        {...baseProps({
          bridge: signedInBridge({
            kind: "subscription",
            planName: "标准版",
            availableCredits: 50,
            usedCredits: 30,
            totalCredits: 80,
            usedPercent: 37.5,
            expiresAt: "2026-12-01T00:00:00Z",
            daysRemaining: 42,
          }),
        })}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "账户" }));

    expect(await screen.findByText("标准版")).toBeInTheDocument();
    expect(screen.getByText("user@answra.local")).toBeInTheDocument();
    // 档位徽章与额度摘要同源：不再保留单独的「套餐」行重复档位名。
    expect(screen.queryByText("套餐")).not.toBeInTheDocument();
    expect(screen.queryByText("免费版")).not.toBeInTheDocument();
  });

  it("shows the free plan badge and welfare source detail for default-kind quota", async () => {
    render(
      <SettingsPanel
        {...baseProps({
          bridge: signedInBridge({
            kind: "default",
            planName: "免费版",
            availableCredits: 18,
            welfareCredits: 10,
            accountCredits: 8,
            welfareExpiresAt: "2026-11-01T00:00:00Z",
            usedPercent: null,
            expiresAt: null,
            daysRemaining: null,
          }),
        })}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "账户" }));

    expect(await screen.findByText("免费版")).toBeInTheDocument();
    expect(screen.getByText("18 积分")).toBeInTheDocument();
    // 额度明细按服务端字段逐行列出：福利积分、账户额度、福利到期，各自独立成行。
    expect(screen.getByText("福利积分")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("账户额度")).toBeInTheDocument();
    expect(screen.getByText("8")).toBeInTheDocument();
    expect(screen.getByText("福利到期")).toBeInTheDocument();
  });

  it("shows subscription quota details as rows with the usage meter", async () => {
    render(
      <SettingsPanel
        {...baseProps({
          bridge: signedInBridge({
            kind: "subscription",
            planName: "标准版",
            availableCredits: 50,
            usedCredits: 30,
            totalCredits: 80,
            usedPercent: 37.5,
            expiresAt: "2026-12-01T00:00:00Z",
            daysRemaining: 42,
          }),
        })}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "账户" }));

    expect(await screen.findByText("50 积分")).toBeInTheDocument();
    // 可用积分是额度卡主行：标签在左、数值在右。
    expect(screen.getByText("可用积分")).toBeInTheDocument();
    expect(screen.getByText("剩余 42 天")).toBeInTheDocument();
    expect(screen.getByText("本周期已用")).toBeInTheDocument();
    expect(screen.getByText("30 / 80 积分")).toBeInTheDocument();
    expect(screen.getByText("套餐到期")).toBeInTheDocument();
    const meter = screen.getByRole("progressbar", { name: "本月额度用量" });
    expect(meter).toHaveAttribute("aria-valuenow", "38");
  });

  it("hides the quota card entirely without server quota data", async () => {
    render(<SettingsPanel {...baseProps({ bridge: signedInBridge(null) })} />);

    fireEvent.click(screen.getByRole("tab", { name: "账户" }));

    expect(await screen.findByText("user@answra.local")).toBeInTheDocument();
    expect(screen.queryByText("额度")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退出登录" })).toBeInTheDocument();
  });

  it("offers only the sign-in action when signed out", async () => {
    render(
      <SettingsPanel
        {...baseProps({
          bridge: authBridge,
          signedIn: false,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "账户" }));

    expect(await screen.findByText("未登录")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "退出登录" })).not.toBeInTheDocument();
    expect(screen.queryByText("额度")).not.toBeInTheDocument();
  });

  it("falls back to the kind-based badge text when the server omits the plan name", async () => {
    render(
      <SettingsPanel
        {...baseProps({
          bridge: signedInBridge({ kind: "subscription", planName: null, availableCredits: 5 }),
        })}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "账户" }));

    expect(await screen.findByText("会员")).toBeInTheDocument();
  });

  it("renders no membership badge when the quota summary is missing", async () => {
    render(<SettingsPanel {...baseProps({ bridge: signedInBridge(null) })} />);

    fireEvent.click(screen.getByRole("tab", { name: "账户" }));

    expect(await screen.findByText("user@answra.local")).toBeInTheDocument();
    expect(screen.queryByText("会员")).not.toBeInTheDocument();
    expect(screen.queryByText("免费版")).not.toBeInTheDocument();
  });

  it("shows the unread count as a badge on the announcements tab and opens the list", async () => {
    render(<SettingsPanel {...baseProps({ bridge: authBridge })} />);

    const announcementsTab = screen.getByRole("tab", { name: /公告/ });
    expect(announcementsTab).toHaveTextContent("1");

    fireEvent.click(announcementsTab);
    expect(screen.getByRole("tab", { name: "公告" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("系统升级")).toBeInTheDocument();
  });

  it("asks the user to sign in on the announcements tab while signed out", () => {
    render(
      <SettingsPanel
        {...baseProps({
          bridge: authBridge,
          signedIn: false,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "公告" }));

    expect(screen.getByText("登录账户后可查看公告。")).toBeInTheDocument();
    expect(screen.queryByText("系统升级")).not.toBeInTheDocument();
  });
});

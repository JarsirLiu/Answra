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

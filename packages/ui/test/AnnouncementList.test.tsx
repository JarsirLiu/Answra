import type { DesktopAnnouncement } from "@answra/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnnouncementList } from "../src/components/panels/AnnouncementList";

const announcements: DesktopAnnouncement[] = [
  {
    id: 1,
    title: "Answra 新版本发布",
    content: "新增桌面端公告中心。",
    platform: "desktop",
    startsAt: null,
    endsAt: null,
    readAt: null,
    createdAt: "2026-10-17T10:00:00Z",
    updatedAt: "2026-10-17T10:00:00Z",
  },
  {
    id: 2,
    title: "节日福利",
    content: "感谢支持。",
    platform: "desktop",
    startsAt: null,
    endsAt: null,
    readAt: "2026-10-16T10:00:00Z",
    createdAt: "2026-10-16T09:00:00Z",
    updatedAt: "2026-10-16T09:00:00Z",
  },
  {
    id: 3,
    title: "积分上新",
    content: "积分商城新增兑换项。",
    platform: "desktop",
    startsAt: null,
    endsAt: null,
    readAt: null,
    createdAt: "2026-10-15T09:00:00Z",
    updatedAt: "2026-10-15T09:00:00Z",
  },
];

describe("AnnouncementList", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("keeps the list a navigation surface without inline content", () => {
    render(<AnnouncementList announcements={announcements} onMarkRead={vi.fn()} />);

    for (const title of ["Answra 新版本发布", "节日福利"]) {
      expect(screen.getByRole("button", { name: new RegExp(title) })).toBeInTheDocument();
    }
    // 正文只允许出现在详情页，列表承载导航版式（2026-10-31 Note 约束一）。
    expect(screen.queryByText("新增桌面端公告中心。")).not.toBeInTheDocument();
    expect(document.querySelector(".announcement-row__dot")).toBeInTheDocument();
  });

  it("opens the detail view and marks an unread announcement as read", async () => {
    const onMarkRead = vi.fn().mockResolvedValue(undefined);
    render(<AnnouncementList announcements={announcements} onMarkRead={onMarkRead} />);

    fireEvent.click(screen.getByRole("button", { name: /Answra 新版本发布/ }));

    expect(await screen.findByText("新增桌面端公告中心。")).toBeInTheDocument();
    await vi.waitFor(() => expect(onMarkRead).toHaveBeenCalledWith(1));
  });

  it("opens an already read announcement without re-marking it", () => {
    const onMarkRead = vi.fn().mockResolvedValue(undefined);
    render(<AnnouncementList announcements={announcements} onMarkRead={onMarkRead} />);

    fireEvent.click(screen.getByRole("button", { name: /节日福利/ }));

    expect(screen.getByText("感谢支持。")).toBeInTheDocument();
    expect(onMarkRead).not.toHaveBeenCalled();
  });

  it("returns to the list through the back control", () => {
    render(<AnnouncementList announcements={announcements} onMarkRead={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Answra 新版本发布/ }));
    fireEvent.click(screen.getByRole("button", { name: "返回公告列表" }));

    expect(screen.queryByText("新增桌面端公告中心。")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /节日福利/ })).toBeInTheDocument();
  });

  it("surfaces a failed mark-read on the detail view instead of swallowing it", async () => {
    const onMarkRead = vi.fn().mockRejectedValue(new Error("标记已读失败"));
    render(<AnnouncementList announcements={announcements} onMarkRead={onMarkRead} />);

    fireEvent.click(screen.getByRole("button", { name: /Answra 新版本发布/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("标记已读失败");
    expect(screen.getByText("新增桌面端公告中心。")).toBeInTheDocument();
  });

  it("falls back to the list when the selected announcement disappears", async () => {
    const onMarkRead = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <AnnouncementList announcements={announcements} onMarkRead={onMarkRead} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /节日福利/ }));
    expect(screen.getByText("感谢支持。")).toBeInTheDocument();

    // 登出/刷新清空公告数组时，详情不能滞留陈旧内容。
    rerender(<AnnouncementList announcements={[]} onMarkRead={onMarkRead} />);
    expect(await screen.findByText("暂无公告")).toBeInTheDocument();
  });

  it("keeps toolbar actions icon-only, enabled only when work remains", () => {
    render(<AnnouncementList announcements={announcements} onMarkRead={vi.fn()} />);

    const markAll = screen.getByRole("button", { name: "全部标为已读" });
    const clear = screen.getByRole("button", { name: "清除已读公告" });
    expect(markAll).toBeEnabled();
    expect(clear).toBeEnabled();
    // 按钮不得再长出文字标签（防腐化约束）。
    expect(markAll).not.toHaveTextContent(/已读|清除/);
    expect(clear).not.toHaveTextContent(/已读|清除/);
    // 原生 title 是 OS 渲染，隐身截屏必泄漏；悬停说明只允许走门控气泡。
    expect(markAll).not.toHaveAttribute("title");
    expect(clear).not.toHaveAttribute("title");
  });

  it("marks every unread announcement as read with one control", async () => {
    const onMarkRead = vi.fn().mockResolvedValue(undefined);
    render(<AnnouncementList announcements={announcements} onMarkRead={onMarkRead} />);

    fireEvent.click(screen.getByRole("button", { name: "全部标为已读" }));

    await vi.waitFor(() => expect(onMarkRead).toHaveBeenCalledTimes(2));
    expect(onMarkRead).toHaveBeenCalledWith(1);
    expect(onMarkRead).toHaveBeenCalledWith(3);
  });

  it("disables toolbar actions when nothing needs acting on", () => {
    const allRead: DesktopAnnouncement[] = announcements.map((item) => ({
      ...item,
      readAt: item.readAt ?? "2026-10-18T10:00:00Z",
    }));
    const full = render(<AnnouncementList announcements={allRead} onMarkRead={vi.fn()} />);

    expect(screen.getByRole("button", { name: "全部标为已读" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "清除已读公告" })).toBeEnabled();

    full.unmount();
    render(<AnnouncementList announcements={[]} onMarkRead={vi.fn()} />);
    expect(screen.getByRole("button", { name: "全部标为已读" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "清除已读公告" })).toBeDisabled();
  });

  it("clears read announcements from the list and persists the dismissal", async () => {
    const onMarkRead = vi.fn().mockResolvedValue(undefined);
    const first = render(
      <AnnouncementList announcements={announcements} onMarkRead={onMarkRead} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "清除已读公告" }));

    expect(screen.queryByRole("button", { name: /节日福利/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Answra 新版本发布/ })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("answra:dismissed-announcements") ?? "[]")).toContain(2);

    // 重开面板（重新挂载）后清走效果保持。
    first.unmount();
    render(<AnnouncementList announcements={announcements} onMarkRead={onMarkRead} />);
    expect(screen.queryByRole("button", { name: /节日福利/ })).not.toBeInTheDocument();

    // 已经没有可清走的已读，动作禁用；未读保留。
    expect(screen.getByRole("button", { name: "清除已读公告" })).toBeDisabled();
  });

  it("surfaces a failed mark-all instead of clearing unread progress", async () => {
    const onMarkRead = vi
      .fn()
      .mockRejectedValueOnce(new Error("标记已读失败"))
      .mockResolvedValue(undefined);
    render(<AnnouncementList announcements={announcements} onMarkRead={onMarkRead} />);

    fireEvent.click(screen.getByRole("button", { name: "全部标为已读" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("标记已读失败");
    // 失败即停：第二条未读不再继续，剩余未读保留至下轮手动重试。
    expect(onMarkRead).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Answra 新版本发布/ })).toBeInTheDocument();
  });

  it("shows an empty placeholder without announcements", () => {
    render(<AnnouncementList announcements={[]} onMarkRead={vi.fn()} />);

    expect(screen.getByText("暂无公告")).toBeInTheDocument();
  });
});

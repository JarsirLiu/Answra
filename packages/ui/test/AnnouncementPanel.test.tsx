import type { DesktopAnnouncement } from "@answra/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AnnouncementPanel } from "../src/components/panels/AnnouncementPanel";

const announcements: DesktopAnnouncement[] = [
  {
    id: 1,
    title: "Answra 新版本发布",
    content: "新增桌面端公告中心。",
    notifyMode: "popup",
    readAt: null,
    createdAt: "2026-10-17T10:00:00Z",
  },
  {
    id: 2,
    title: "节日福利",
    content: "感谢支持。",
    notifyMode: "silent",
    readAt: "2026-10-16T10:00:00Z",
    createdAt: "2026-10-16T09:00:00Z",
  },
];

describe("AnnouncementPanel", () => {
  it("shows site announcement content and distinguishes popup and unread items", () => {
    render(
      <AnnouncementPanel announcements={announcements} onClose={vi.fn()} onMarkRead={vi.fn()} />,
    );

    expect(screen.getByText("Answra 新版本发布")).toBeInTheDocument();
    expect(screen.getByText("新增桌面端公告中心。")).toBeInTheDocument();
    expect(screen.getByText("重要")).toBeInTheDocument();
    expect(screen.getAllByText("未读")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "标记已读：节日福利" })).not.toBeInTheDocument();
  });

  it("marks an unread announcement as read through the supplied account bridge", () => {
    const onMarkRead = vi.fn().mockResolvedValue(undefined);
    render(
      <AnnouncementPanel announcements={announcements} onClose={vi.fn()} onMarkRead={onMarkRead} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "标记已读：Answra 新版本发布" }));

    expect(onMarkRead).toHaveBeenCalledWith(1);
  });
});

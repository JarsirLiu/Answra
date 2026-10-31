import type { DesktopAnnouncement } from "@answra/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
];

describe("AnnouncementList", () => {
  it("shows announcement content and only marks unread items", () => {
    render(<AnnouncementList announcements={announcements} onMarkRead={vi.fn()} />);

    expect(screen.getByText("Answra 新版本发布")).toBeInTheDocument();
    expect(screen.getByText("新增桌面端公告中心。")).toBeInTheDocument();
    expect(screen.queryByText("重要")).not.toBeInTheDocument();
    expect(screen.getAllByText("未读")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "标记已读：节日福利" })).not.toBeInTheDocument();
  });

  it("marks an unread announcement as read through the supplied account bridge", async () => {
    const onMarkRead = vi.fn().mockResolvedValue(undefined);
    render(<AnnouncementList announcements={announcements} onMarkRead={onMarkRead} />);

    fireEvent.click(screen.getByRole("button", { name: "标记已读：Answra 新版本发布" }));

    await vi.waitFor(() => expect(onMarkRead).toHaveBeenCalledWith(1));
  });

  it("shows an empty placeholder without announcements", () => {
    render(<AnnouncementList announcements={[]} onMarkRead={vi.fn()} />);

    expect(screen.getByText("暂无公告")).toBeInTheDocument();
  });

  it("surfaces a failed mark-read instead of swallowing it", async () => {
    const onMarkRead = vi.fn().mockRejectedValue(new Error("标记已读失败"));
    render(<AnnouncementList announcements={announcements} onMarkRead={onMarkRead} />);

    fireEvent.click(screen.getByRole("button", { name: "标记已读：Answra 新版本发布" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("标记已读失败");
  });
});

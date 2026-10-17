import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceControls } from "../src/components/floating-bar/WorkspaceControls";

describe("WorkspaceControls announcements entry", () => {
  it("keeps the announcement entry hidden until account sign-in", () => {
    render(
      <WorkspaceControls
        onClose={vi.fn()}
        onTogglePanel={vi.fn()}
        panel="closed"
        showAnnouncements={false}
        unreadAnnouncements={0}
      />,
    );

    expect(screen.getByRole("button", { name: "打开笔记本" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开公告" })).not.toBeInTheDocument();
  });

  it("shows the unread count and opens the announcement panel", () => {
    const onTogglePanel = vi.fn();
    render(
      <WorkspaceControls
        onClose={vi.fn()}
        onTogglePanel={onTogglePanel}
        panel="closed"
        showAnnouncements
        unreadAnnouncements={3}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "打开公告，有 3 条未读" }));

    expect(onTogglePanel).toHaveBeenCalledWith("announcements");
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});

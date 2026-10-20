import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceControls } from "../src/components/floating-bar/WorkspaceControls";

describe("WorkspaceControls third segment", () => {
  it("keeps notebook, settings and close entries on the bar", () => {
    render(<WorkspaceControls onClose={vi.fn()} onTogglePanel={vi.fn()} panel="closed" />);

    expect(screen.getByRole("button", { name: "打开笔记本" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭应用" })).toBeInTheDocument();
  });

  it("moves the announcement entry into the settings panel instead of a bell on the bar", () => {
    render(<WorkspaceControls onClose={vi.fn()} onTogglePanel={vi.fn()} panel="closed" />);

    // 公告并入设置面板 Tab 后，悬浮条不再有独立的公告入口。
    expect(screen.queryByRole("button", { name: /打开公告/ })).not.toBeInTheDocument();
    expect(document.querySelector(".announcement-count")).not.toBeInTheDocument();
  });
});

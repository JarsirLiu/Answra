import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolCallCard } from "../src/components/tool-call/ToolCallCard";
import type { ToolCallPart } from "../src/components/tool-call/toolCallPart";

function toolPart(overrides: Partial<ToolCallPart> = {}): ToolCallPart {
  return {
    id: "tool-1",
    kind: "tool",
    toolCallId: "tool-1",
    toolName: "Read",
    state: "completed",
    ...overrides,
  };
}

describe("ToolCallCard", () => {
  it("keeps the summary compact and shows the lifecycle label without details", () => {
    render(
      <ToolCallCard
        actionLabel="读取"
        icon={<span aria-hidden="true">icon</span>}
        meta="2 行"
        part={toolPart({ state: "running" })}
        primary="a.ts"
        secondary="src"
      />,
    );

    expect(screen.getByText("读取")).toBeInTheDocument();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("运行中")).toBeInTheDocument();
    expect(screen.queryByText("src")).toBeNull();
    expect(screen.queryByText("2 行")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the streamed argument size only while input is still streaming", () => {
    const { rerender } = render(
      <ToolCallCard
        actionLabel="Edited"
        icon={null}
        part={toolPart({ state: "input-streaming", inputText: "x".repeat(1536) })}
        primary="文件"
      />,
    );

    expect(screen.getByText("准备中")).toHaveAttribute("data-running", "true");
    expect(screen.getByText("1.5 KB")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();

    rerender(
      <ToolCallCard
        actionLabel="Edited"
        icon={null}
        part={toolPart({ state: "pending", inputText: "x".repeat(1536), input: {} })}
        primary="文件"
      />,
    );

    expect(screen.queryByText("1.5 KB")).toBeNull();
  });

  it("hides the lifecycle label once the call has completed", () => {
    render(<ToolCallCard actionLabel="读取" icon={null} part={toolPart()} primary="a.ts" />);

    expect(screen.queryByText("完成")).toBeNull();
  });

  it("expands details only after the header is activated", () => {
    render(
      <ToolCallCard actionLabel="读取" icon={null} part={toolPart()} primary="a.ts">
        <p>文件内容</p>
      </ToolCallCard>,
    );

    const header = screen.getByRole("button", { name: /读取/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("文件内容")).toBeNull();

    fireEvent.click(header);

    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("文件内容")).toBeInTheDocument();
  });

  it("shows failure in the status line without auto-expanding the error details", () => {
    render(
      <ToolCallCard
        actionLabel="读取"
        icon={null}
        part={toolPart({ state: "failed", errorText: "文件不存在" })}
        primary="missing.ts"
      >
        <p>错误详情</p>
      </ToolCallCard>,
    );

    const status = screen.getByText("失败");
    expect(status).toHaveAttribute("title", "文件不存在");
    expect(screen.getByRole("button", { name: /读取/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("错误详情")).toBeNull();
  });
});

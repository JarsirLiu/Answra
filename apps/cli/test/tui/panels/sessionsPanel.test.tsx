import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { SessionsPanel } from "../../../src/tui/panels/SessionsPanel";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function session(id: string, title = `title-${id}`) {
  return {
    conversationId: id,
    scope: "coding" as const,
    title,
    messageCount: 1,
    createdAt: "2026-11-17T09:28:00.000Z",
    updatedAt: "2026-11-17T09:28:00.000Z",
  };
}

describe("SessionsPanel", () => {
  it("lists sessions, marks the current one, and resumes the picked session", async () => {
    const resume = vi.fn(async () => {});
    const close = vi.fn();
    const instance = render(
      <SessionsPanel
        close={close}
        load={async () => ({
          current: "conversation-a",
          sessions: [session("conversation-a"), session("conversation-b")],
        })}
        resume={resume}
      />,
    );
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("Current session"));

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("历史会话");
    expect(frame).toContain("conversa");
    expect(frame).toContain("title-conversation-b");

    instance.stdin.write("\u001b[B");
    await tick();
    instance.stdin.write("\r");
    await vi.waitFor(() => expect(resume).toHaveBeenCalledWith("conversation-b"));
    expect(close).toHaveBeenCalledTimes(1);
    instance.unmount();
  });

  it("scrolls long session lists to keep the focused row visible", async () => {
    const sessions = Array.from({ length: 16 }, (_, index) =>
      session(`conversation-${String(index).padStart(2, "0")}`),
    );
    const instance = render(
      <SessionsPanel
        close={vi.fn()}
        load={async () => ({ current: "conversation-00", sessions })}
        resume={vi.fn()}
      />,
    );
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("↓ 4 more…"));

    for (let index = 0; index < 12; index += 1) {
      instance.stdin.write("\u001b[B");
      await tick();
    }

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("↑ 1 more…");
    expect(frame).toContain("conversation-12");
    expect(frame).not.toContain("conversation-00");
    instance.unmount();
  });

  it("pages with PgDn and reports an empty workspace", async () => {
    const instance = render(
      <SessionsPanel
        close={vi.fn()}
        load={async () => ({ current: "", sessions: [] })}
        resume={vi.fn()}
      />,
    );
    await vi.waitFor(() =>
      expect(instance.lastFrame()).toContain("当前 workspace 还没有历史会话。"),
    );

    instance.stdin.write("\u001b[6~");
    await tick();
    expect(instance.lastFrame()).toContain("当前 workspace 还没有历史会话。");
    instance.unmount();
  });

  it("shows load errors without dropping the list", async () => {
    const instance = render(
      <SessionsPanel
        close={vi.fn()}
        load={async () => ({ current: "", sessions: [], error: "当前宿主不支持会话历史。" })}
        resume={vi.fn()}
      />,
    );
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("当前宿主不支持会话历史。"));
    instance.unmount();
  });

  it("keeps the panel open and shows the failure when resume throws", async () => {
    const close = vi.fn();
    const instance = render(
      <SessionsPanel
        close={close}
        load={async () => ({ current: "", sessions: [session("conversation-a")] })}
        resume={async () => {
          throw new Error("当前运行中，先按 Esc 中断后再恢复会话。");
        }}
      />,
    );
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("title-conversation-a"));

    instance.stdin.write("\r");
    await vi.waitFor(() =>
      expect(instance.lastFrame()).toContain("当前运行中，先按 Esc 中断后再恢复会话。"),
    );
    expect(close).not.toHaveBeenCalled();
    instance.unmount();
  });
});

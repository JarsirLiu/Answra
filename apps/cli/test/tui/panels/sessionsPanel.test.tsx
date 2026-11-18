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
        remove={vi.fn()}
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
        remove={vi.fn()}
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

  it("loads the next page when the last loaded row is focused", async () => {
    const load = vi.fn(async (cursor?: string) =>
      cursor === undefined
        ? { current: "conversation-a", sessions: [session("conversation-a")], nextCursor: "next" }
        : { current: "conversation-a", sessions: [session("conversation-b")] },
    );
    const instance = render(
      <SessionsPanel close={vi.fn()} load={load} remove={vi.fn()} resume={vi.fn()} />,
    );
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("title-conversation-a"));

    instance.stdin.write("\u001b[B");
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith("next"));
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("title-conversation-b"));
    instance.unmount();
  });

  it("pages with PgDn and reports an empty workspace", async () => {
    const instance = render(
      <SessionsPanel
        close={vi.fn()}
        load={async () => ({ current: "", sessions: [] })}
        remove={vi.fn()}
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
        remove={vi.fn()}
        resume={vi.fn()}
      />,
    );
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("当前宿主不支持会话历史。"));
    instance.unmount();
  });

  it("keeps a long title on one truncated line instead of wrapping", async () => {
    const tail = "TAIL-MARKER";
    const longTitle = `宽字符标题片段-${"样例".repeat(200)}${tail}`;
    const instance = render(
      <SessionsPanel
        close={vi.fn()}
        load={async () => ({
          current: "",
          sessions: [session("conversation-long", longTitle)],
        })}
        remove={vi.fn()}
        resume={vi.fn()}
      />,
    );
    const frame = await vi.waitFor(() => {
      const current = instance.lastFrame() ?? "";
      expect(current).toContain("conversa");
      return current;
    });

    expect(frame).toContain("…");
    expect(frame).not.toContain(tail);
    const titleLine = frame.split("\n").find((line) => line.includes("conversa"));
    expect(titleLine).toContain("2026-11-17 09:28");
    expect(titleLine).toContain("宽字符标题片段-");
    instance.unmount();
  });

  it("aligns short ids in a fixed-width first column", async () => {
    const instance = render(
      <SessionsPanel
        close={vi.fn()}
        load={async () => ({
          current: "",
          sessions: [session("ab"), session("conversation-wide")],
        })}
        remove={vi.fn()}
        resume={vi.fn()}
      />,
    );
    const frame = await vi.waitFor(() => {
      const current = instance.lastFrame() ?? "";
      expect(current).toContain("title-conversation-wide");
      return current;
    });

    const rows = frame
      .split("\n")
      .filter((line) => line.includes("2026-11-17 09:28"))
      .map((line) => line.indexOf("2026-11-17 09:28"));
    expect(rows.length).toBeGreaterThan(1);
    expect(new Set(rows).size).toBe(1);
    instance.unmount();
  });

  it("keeps the panel open and shows the failure when resume throws", async () => {
    const close = vi.fn();
    const instance = render(
      <SessionsPanel
        close={close}
        load={async () => ({ current: "", sessions: [session("conversation-a")] })}
        remove={vi.fn()}
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

  it("copies the full conversation id with Ctrl+Y", async () => {
    const copyText = vi.fn();
    const instance = render(
      <SessionsPanel
        close={vi.fn()}
        copyText={copyText}
        load={async () => ({
          current: "",
          sessions: [session("conversation-a"), session("conversation-b")],
        })}
        remove={vi.fn()}
        resume={vi.fn()}
      />,
    );
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("title-conversation-a"));

    instance.stdin.write("\u0019");
    await vi.waitFor(() => expect(copyText).toHaveBeenCalledWith("conversation-a"));
    expect(instance.lastFrame()).toContain("已复制会话 ID：conversation-a");
    instance.unmount();
  });

  it("deletes the selected session only after a second Ctrl+D", async () => {
    const remove = vi.fn(async () => {});
    const instance = render(
      <SessionsPanel
        close={vi.fn()}
        load={async () => ({
          current: "",
          sessions: [session("conversation-a"), session("conversation-b")],
        })}
        remove={remove}
        resume={vi.fn()}
      />,
    );
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("title-conversation-a"));

    instance.stdin.write("\u0004");
    await tick();
    expect(remove).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain("再按 Ctrl+D 确认删除：conversation-a");

    instance.stdin.write("\u0004");
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith("conversation-a"));
    await vi.waitFor(() => expect(instance.lastFrame()).not.toContain("title-conversation-a"));
    instance.unmount();
  });
});

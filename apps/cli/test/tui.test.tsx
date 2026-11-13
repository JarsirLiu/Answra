import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/tui/components/App";
import { PromptInput } from "../src/tui/components/PromptInput";
import { Transcript } from "../src/tui/components/Transcript";
import { TuiViewStore } from "../src/tui/viewStore";

function nextFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createWheelSource() {
  const listeners = new Set<(direction: -1 | 1) => void>();
  return {
    subscribe(listener: (direction: -1 | 1) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(direction: -1 | 1) {
      for (const listener of listeners) listener(direction);
    },
  };
}

describe("TUI components", () => {
  it("submits trimmed prompt text and clears the input", async () => {
    const onSubmit = vi.fn();
    const instance = render(<PromptInput busy={false} onSubmit={onSubmit} />);

    instance.stdin.write("  hello  ");
    await nextFrame();
    instance.stdin.write("\r");
    await nextFrame();

    expect(onSubmit).toHaveBeenCalledWith("hello");
    expect(instance.lastFrame()).not.toContain("hello");
    instance.unmount();
  });

  it("supports backslash continuation for multiline input", async () => {
    const onSubmit = vi.fn();
    const instance = render(<PromptInput busy={false} onSubmit={onSubmit} />);

    instance.stdin.write("first\\");
    await nextFrame();
    instance.stdin.write("\r");
    await nextFrame();
    instance.stdin.write("second");
    await nextFrame();
    instance.stdin.write("\r");

    expect(onSubmit).toHaveBeenCalledWith("first\nsecond");
    instance.unmount();
  });

  it("queues a prompt submitted while a run is active", async () => {
    const onSubmit = vi.fn();
    const instance = render(<PromptInput busy onSubmit={onSubmit} />);

    instance.stdin.write("queued");
    await nextFrame();
    instance.stdin.write("\r");
    await nextFrame();

    expect(onSubmit).toHaveBeenCalledWith("queued");
    expect(instance.lastFrame()).not.toContain("queued");
    instance.unmount();
  });

  it("clears the draft on Ctrl-C before arming exit", async () => {
    const onSubmit = vi.fn();
    const instance = render(<PromptInput busy={false} onSubmit={onSubmit} />);

    instance.stdin.write("draft");
    await nextFrame();
    instance.stdin.write("\u0003");
    await nextFrame();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(instance.lastFrame()).not.toContain("draft");
    expect(instance.lastFrame()).toContain("再按一次 Ctrl-C 退出");
    instance.unmount();
  });

  it("mounts the app shell with welcome, prompt, and status line", async () => {
    const store = new TuiViewStore();
    store.initialize({ conversationId: "conversation-1", eventRevision: 0, messages: [] });
    const instance = render(
      <App
        botName="coding.engineer"
        model="test-model"
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        store={store}
        workspaceRoot="D:\\workspace"
      />,
    );
    await nextFrame();

    expect(instance.lastFrame()).toContain("Answra Code");
    expect(instance.lastFrame()).toContain("❯");
    expect(instance.lastFrame()).toContain("coding.engineer");
    instance.unmount();
    store.dispose();
  });

  it("keeps the latest transcript line visible in a short viewport", async () => {
    const store = new TuiViewStore();
    store.initialize({
      conversationId: "conversation-1",
      eventRevision: 0,
      messages: Array.from({ length: 40 }, (_, index) => ({
        id: `assistant-${index}`,
        role: "assistant" as const,
        text: `line-${index}`,
        status: "complete" as const,
        images: [],
        parts: [
          {
            id: `part-${index}`,
            kind: "text" as const,
            text: `line-${index}`,
            state: "completed" as const,
          },
        ],
      })),
    });
    const instance = render(
      <App
        botName="coding.engineer"
        model="test-model"
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        store={store}
        workspaceRoot="D:\\workspace"
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(instance.lastFrame()).toContain("line-39");
    expect(instance.lastFrame()).not.toContain("line-0");
    instance.unmount();
    store.dispose();
  });

  it("scrolls the transcript with PgUp and the mouse wheel while Home/End stay with the input", async () => {
    const store = new TuiViewStore();
    const wheel = createWheelSource();
    store.initialize({
      conversationId: "conversation-1",
      eventRevision: 0,
      messages: Array.from({ length: 20 }, (_, index) => ({
        id: `assistant-${index}`,
        role: "assistant" as const,
        text: `line-${index}`,
        status: "complete" as const,
        images: [],
        parts: [
          {
            id: `part-${index}`,
            kind: "text" as const,
            text: `line-${index}`,
            state: "completed" as const,
          },
        ],
      })),
    });
    const instance = render(
      <App
        botName="coding.engineer"
        model="test-model"
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        store={store}
        wheelSource={wheel}
        workspaceRoot="D:\\workspace"
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(instance.lastFrame()).toContain("line-19");

    instance.stdin.write("\x1b[H");
    await nextFrame();
    expect(instance.lastFrame()).toContain("line-19");

    instance.stdin.write("\x1b[5~");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(instance.lastFrame()).not.toContain("line-19");

    for (let index = 0; index < 20; index += 1) wheel.emit(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(instance.lastFrame()).toContain("line-19");

    for (let index = 0; index < 20; index += 1) wheel.emit(-1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(instance.lastFrame()).toContain("line-0");

    instance.unmount();
    store.dispose();
  }, 45_000);

  it("keeps a manually scrolled history while a run streams", async () => {
    const store = new TuiViewStore();
    const wheel = createWheelSource();
    let messages = Array.from({ length: 20 }, (_, index) => ({
      id: `assistant-${index}`,
      role: "assistant" as const,
      text: `line-${index}`,
      status: "complete" as const,
      images: [],
      parts: [
        {
          id: `part-${index}`,
          kind: "text" as const,
          text: `line-${index}`,
          state: "completed" as const,
        },
      ],
    }));
    store.initialize({ conversationId: "conversation-1", eventRevision: 0, messages });
    const instance = render(
      <App
        botName="coding.engineer"
        model="test-model"
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        store={store}
        wheelSource={wheel}
        workspaceRoot="D:\\workspace"
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    store.beginRun();

    for (let index = 0; index < 20; index += 1) wheel.emit(-1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(instance.lastFrame()).toContain("line-0");

    for (let revision = 1; revision <= 3; revision += 1) {
      const index = 20 + revision - 1;
      messages = [
        ...messages,
        {
          id: `assistant-${index}`,
          role: "assistant",
          text: `line-${index}`,
          status: "complete",
          images: [],
          parts: [{ id: `part-${index}`, kind: "text", text: `line-${index}`, state: "completed" }],
        },
      ];
      store.applySnapshot({
        conversationId: "conversation-1",
        eventRevision: revision,
        messages,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(instance.lastFrame()).toContain("line-0");
    expect(instance.lastFrame()).not.toContain("line-22");
    instance.unmount();
    store.dispose();
  }, 60_000);

  it("collapses thinking until Ctrl+O expands it", async () => {
    const store = new TuiViewStore();
    store.initialize({
      conversationId: "conversation-1",
      eventRevision: 0,
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          text: "answer",
          status: "complete",
          images: [],
          parts: [
            {
              id: "reasoning-1",
              kind: "reasoning",
              text: "hidden chain of thought",
              state: "completed",
            },
            { id: "text-1", kind: "text", text: "answer", state: "completed" },
          ],
        },
      ],
    });
    const instance = render(
      <App
        botName="coding.engineer"
        model="test-model"
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        store={store}
        workspaceRoot="D:\\workspace"
      />,
    );
    await nextFrame();

    expect(instance.lastFrame()).toContain("Thinking");
    expect(instance.lastFrame()).not.toContain("hidden chain of thought");

    instance.stdin.write("\u000f");
    await nextFrame();

    expect(instance.lastFrame()).toContain("hidden chain of thought");
    instance.unmount();
    store.dispose();
  });

  it("shows only the latest turn's thinking until Ctrl+O expands history", async () => {
    const store = new TuiViewStore();
    store.initialize({
      conversationId: "conversation-1",
      eventRevision: 0,
      messages: [
        {
          id: "user-1",
          role: "user",
          text: "first",
          status: "complete",
          images: [],
        },
        {
          id: "assistant-1",
          role: "assistant",
          text: "first answer",
          status: "complete",
          images: [],
          parts: [
            { id: "r1", kind: "reasoning", text: "old thought", state: "completed" },
            { id: "t1", kind: "text", text: "first answer", state: "completed" },
          ],
        },
        {
          id: "user-2",
          role: "user",
          text: "second",
          status: "complete",
          images: [],
        },
        {
          id: "assistant-2",
          role: "assistant",
          text: "second answer",
          status: "complete",
          images: [],
          parts: [
            { id: "r2", kind: "reasoning", text: "new thought", state: "completed" },
            { id: "t2", kind: "text", text: "second answer", state: "completed" },
          ],
        },
      ],
    });
    const instance = render(
      <App
        botName="coding.engineer"
        model="test-model"
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        store={store}
        workspaceRoot="D:\\workspace"
      />,
    );
    await nextFrame();

    expect(instance.lastFrame()).toContain("Thinking");
    expect(instance.lastFrame()).not.toContain("new thought");
    expect(instance.lastFrame()).not.toContain("old thought");

    instance.stdin.write("\u000f");
    await nextFrame();

    expect(instance.lastFrame()).toContain("old thought");
    expect(instance.lastFrame()).toContain("new thought");
    instance.unmount();
    store.dispose();
  });

  it("renders the welcome state and transcript errors", async () => {
    const instance = render(
      <Transcript
        localError="send failed"
        notice={["会话已清除。"]}
        view={{
          eventRevision: 0,
          messages: [
            {
              id: "user-1",
              role: "user",
              text: "find the bug",
              status: "complete",
            },
          ],
          error: "model failed",
        }}
        workspaceRoot="D:\\workspace"
      />,
    );
    await nextFrame();

    expect(instance.lastFrame()).toContain("find the bug");
    expect(instance.lastFrame()).toContain("model failed");
    expect(instance.lastFrame()).toContain("send failed");
    expect(instance.lastFrame()).toContain("会话已清除。");
    instance.unmount();
  });
});

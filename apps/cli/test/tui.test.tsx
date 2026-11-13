import { EventEmitter } from "node:events";
import { render as inkRender } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/tui/app/App";
import { TuiViewStore } from "../src/tui/app/viewStore";
import { PromptInput } from "../src/tui/composer/PromptInput";
import type { PointerEvent } from "../src/tui/interaction/pointerInput";
import { TuiSelectionStore } from "../src/tui/interaction/selectionStore";
import type { TuiPanelHandlers } from "../src/tui/panel";
import { Transcript, Welcome } from "../src/tui/transcript/Transcript";

const PANEL_HANDLERS: TuiPanelHandlers = {
  loadConfig: async () => ({ baseUrl: "", chatModel: "", apiKey: "" }),
  saveConfig: async () => {},
  loadModels: async () => ({ current: "", models: [] }),
  selectModel: async () => {},
  close: () => {},
};

function nextFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class CursorProbeStdout extends EventEmitter {
  readonly isTTY = true;
  readonly columns = 80;
  readonly rows = 24;
  readonly chunks: string[] = [];
  write = (data: string, encodingOrCallback?: unknown, callback?: () => void) => {
    this.chunks.push(String(data));
    if (typeof encodingOrCallback === "function") encodingOrCallback();
    else callback?.();
    return true;
  };
}

class CursorProbeStdin extends EventEmitter {
  readonly isTTY = true;
  private data: string | null = null;
  write = (data: string) => {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  };
  setRawMode() {}
  setEncoding() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => {
    const data = this.data;
    this.data = null;
    return data;
  };
}

const ESC = String.fromCharCode(27);

/** 取最后一次 cursorTo + show 序列的列号，验证真实终端光标被停到输入框。 */
function lastParkedCursorColumn(raw: string): number | undefined {
  const segments = raw.split(`${ESC}[?25h`);
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const segment = segments[index] ?? "";
    const start = segment.lastIndexOf(`${ESC}[`);
    if (start === -1) continue;
    const token = segment.slice(start + ESC.length + 1);
    if (!token.endsWith("G")) continue;
    const column = Number(token.slice(0, -1));
    if (Number.isInteger(column)) return column - 1;
  }
  return undefined;
}

function createPointerSource() {
  const listeners = new Set<(event: PointerEvent) => void>();
  return {
    subscribe(listener: (event: PointerEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: PointerEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

function wheelEvent(direction: -1 | 1): PointerEvent {
  return { kind: "wheel", direction, point: { row: 0, col: 0 } };
}

describe("TUI components", () => {
  it("shows model onboarding on the welcome page when no model is configured", async () => {
    const instance = render(<Welcome modelConfigured={false} workspaceRoot="D:\\workspace" />);
    await nextFrame();

    const frame = instance.lastFrame();
    expect(frame).toContain("模型配置");
    expect(frame).toContain("Base URL");
    expect(frame).toContain("API Key");
    expect(frame).toContain("模型 ID");
    instance.unmount();
  });

  it("shows all model setup rows and highlights the current step", async () => {
    const instance = render(
      <Welcome modelConfigured={false} setupStep="model-id" workspaceRoot="D:\\workspace" />,
    );
    await nextFrame();

    const frame = instance.lastFrame();
    expect(frame).toContain("✓ Base URL");
    expect(frame).toContain("✓ API Key");
    expect(frame).toContain("❯ 模型 ID");
    expect(frame).not.toContain("已完成");
    expect(frame).not.toContain("待填写");
    instance.unmount();
  });

  it("parks the real terminal cursor at the input caret for IME", async () => {
    const stdout = new CursorProbeStdout();
    const stdin = new CursorProbeStdin();
    const instance = inkRender(<PromptInput busy={false} onSubmit={vi.fn()} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      interactive: true,
      alternateScreen: true,
      exitOnCtrlC: false,
      patchConsole: false,
      incrementalRendering: true,
      maxFps: 60,
    });

    await nextFrame();
    await instance.waitUntilRenderFlush();
    stdin.write("a");
    await nextFrame();
    await instance.waitUntilRenderFlush();
    const afterAscii = lastParkedCursorColumn(stdout.chunks.join(""));
    stdin.write("中");
    await nextFrame();
    await instance.waitUntilRenderFlush();
    const afterWide = lastParkedCursorColumn(stdout.chunks.join(""));

    expect(afterAscii).toBeDefined();
    expect(afterWide).toBe((afterAscii ?? 0) + 2);
    instance.unmount();
  });

  it("shows Claude-style compaction progress and leaves a compacted boundary", async () => {
    const store = new TuiViewStore();
    const message = {
      id: "message-1",
      role: "user" as const,
      text: "question",
      images: [],
      status: "complete" as const,
    };
    store.initialize({
      conversationId: "conversation-1",
      eventRevision: 1,
      messages: [message],
      contextCompaction: {
        state: "started",
        trigger: "auto",
        startedAt: "2026-11-14T10:00:00.000Z",
        updatedAt: "2026-11-14T10:00:00.000Z",
      },
    });
    store.beginRun();
    const stdout = new CursorProbeStdout();
    const stdin = new CursorProbeStdin();
    const instance = inkRender(
      <App
        botName="coding.engineer"
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        store={store}
        panelHandlers={PANEL_HANDLERS}
        workspaceRoot="D:\\workspace"
      />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        interactive: true,
        alternateScreen: true,
        exitOnCtrlC: false,
        patchConsole: false,
        incrementalRendering: true,
        maxFps: 60,
      },
    );
    await nextFrame();
    await instance.waitUntilRenderFlush();
    expect(stdout.chunks.join("")).toContain("Compacting conversation");

    store.applySnapshot({
      conversationId: "conversation-1",
      eventRevision: 2,
      messages: [message],
      contextCompaction: {
        state: "succeeded",
        trigger: "auto",
        startedAt: "2026-11-14T10:00:00.000Z",
        updatedAt: "2026-11-14T10:00:01.000Z",
        finishedAt: "2026-11-14T10:00:01.000Z",
        summarizedMessages: 8,
      },
    });
    await nextFrame();
    await instance.waitUntilRenderFlush();

    const frame = stdout.chunks.join("");
    expect(frame).toContain("✻ Conversation compacted (ctrl+o for history)");
    expect(frame).not.toContain("条消息");
    instance.unmount();
    store.dispose();
  });

  it("keeps the Claude compaction failure visible while a run is active", async () => {
    const store = new TuiViewStore();
    store.initialize({
      conversationId: "conversation-1",
      eventRevision: 1,
      messages: [
        {
          id: "message-1",
          role: "user",
          text: "question",
          images: [],
          status: "complete",
        },
      ],
      contextCompaction: {
        state: "failed",
        trigger: "auto",
        startedAt: "2026-11-14T10:00:00.000Z",
        updatedAt: "2026-11-14T10:00:01.000Z",
        finishedAt: "2026-11-14T10:00:01.000Z",
        errorText: "provider unavailable",
      },
    });
    store.beginRun();
    const stdout = new CursorProbeStdout();
    const stdin = new CursorProbeStdin();
    const instance = inkRender(
      <App
        botName="coding.engineer"
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        store={store}
        panelHandlers={PANEL_HANDLERS}
        workspaceRoot="D:\\workspace"
      />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        interactive: true,
        alternateScreen: true,
        exitOnCtrlC: false,
        patchConsole: false,
        incrementalRendering: true,
        maxFps: 60,
      },
    );
    await nextFrame();
    await instance.waitUntilRenderFlush();

    const frame = stdout.chunks.join("");
    expect(frame).toContain("Error compacting conversation");
    expect(frame).toContain("esc to interrupt");
    instance.unmount();
    store.dispose();
  });

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

  it("selects all with Ctrl+A and cuts the selection to the clipboard", async () => {
    const onCopyText = vi.fn();
    const instance = render(
      <PromptInput busy={false} onCopyText={onCopyText} onSubmit={vi.fn()} />,
    );

    instance.stdin.write("hello 世界");
    await nextFrame();
    instance.stdin.write("\u0001");
    await nextFrame();
    instance.stdin.write("\u0018");
    await nextFrame();

    expect(onCopyText).toHaveBeenCalledWith("hello 世界");
    expect(instance.lastFrame()).not.toContain("hello");
    instance.unmount();
  });

  it("replaces the selection when typing or deleting", async () => {
    const instance = render(<PromptInput busy={false} onSubmit={vi.fn()} />);

    instance.stdin.write("abc");
    await nextFrame();
    instance.stdin.write("\u0001");
    await nextFrame();
    instance.stdin.write("z");
    await nextFrame();
    expect(instance.lastFrame()).toContain("z");
    expect(instance.lastFrame()).not.toContain("abc");

    instance.stdin.write("\u0001");
    await nextFrame();
    instance.stdin.write("\u007f");
    await nextFrame();
    expect(instance.lastFrame()).not.toContain("z");
    instance.unmount();
  });

  it("moves to the start and end of a single visual line before browsing history", async () => {
    const instance = render(<PromptInput busy={false} onSubmit={vi.fn()} />);

    instance.stdin.write("abc");
    await nextFrame();
    instance.stdin.write("\u001b[A");
    await nextFrame();
    instance.stdin.write("!");
    await nextFrame();
    expect(instance.lastFrame()).toContain("!abc");

    instance.stdin.write("\u001b[B");
    await nextFrame();
    instance.stdin.write("?");
    await nextFrame();
    expect(instance.lastFrame()).toContain("!abc?");
    instance.unmount();
  });

  it("browses history only after the single-line cursor reaches the start", async () => {
    const instance = render(<PromptInput busy={false} onSubmit={vi.fn()} />);

    instance.stdin.write("first");
    await nextFrame();
    instance.stdin.write("\r");
    await nextFrame();
    instance.stdin.write("abc");
    await nextFrame();
    instance.stdin.write("\u001b[A");
    await nextFrame();
    instance.stdin.write("\u001b[A");
    await nextFrame();

    expect(instance.lastFrame()).toContain("first");
    instance.unmount();
  });

  it("masks secret input, keeps it out of history, and allows empty submit", async () => {
    const onSubmit = vi.fn();
    const instance = render(
      <PromptInput allowEmptySubmit busy={false} onSubmit={onSubmit} secret />,
    );

    instance.stdin.write("sk-secret");
    await nextFrame();
    const frame = instance.lastFrame();
    expect(frame).not.toContain("sk-secret");
    expect(frame).toContain("•");

    instance.stdin.write("\r");
    await nextFrame();
    expect(onSubmit).toHaveBeenCalledWith("sk-secret");

    instance.stdin.write("\u001b[A");
    await nextFrame();
    expect(instance.lastFrame()).not.toContain("sk-secret");

    instance.stdin.write("\r");
    await nextFrame();
    expect(onSubmit).toHaveBeenLastCalledWith("");
    instance.unmount();
  });

  it("shows slash command candidates and completes the selected command with Tab", async () => {
    const onSubmit = vi.fn();
    const instance = render(<PromptInput busy={false} onSubmit={onSubmit} />);

    instance.stdin.write("/");
    await nextFrame();
    expect(instance.lastFrame()).toContain("/help");
    expect(instance.lastFrame()).toContain("显示本帮助");

    instance.stdin.write("\t");
    await nextFrame();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(instance.lastFrame()).not.toContain("显示本帮助");

    instance.stdin.write("\r");
    await nextFrame();
    expect(onSubmit).toHaveBeenCalledWith("/help");
    instance.unmount();
  });

  it("moves the command selection before completing it", async () => {
    const onSubmit = vi.fn();
    const instance = render(<PromptInput busy={false} onSubmit={onSubmit} />);

    instance.stdin.write("/");
    await nextFrame();
    instance.stdin.write("\u001b[B");
    await nextFrame();
    instance.stdin.write("\t");
    await nextFrame();

    instance.stdin.write("\r");
    await nextFrame();
    expect(onSubmit).toHaveBeenCalledWith("/clear");
    instance.unmount();
  });

  it("completes a command prefix with Enter before submitting it", async () => {
    const onSubmit = vi.fn();
    const instance = render(<PromptInput busy={false} onSubmit={onSubmit} />);

    instance.stdin.write("/mo");
    await nextFrame();
    instance.stdin.write("\r");
    await nextFrame();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain("/model");

    instance.stdin.write("qwen");
    await nextFrame();
    instance.stdin.write("\r");
    await nextFrame();
    expect(onSubmit).toHaveBeenCalledWith("/model qwen");
    instance.unmount();
  });

  it("dismisses the command palette with Escape and reopens it with Tab", async () => {
    const instance = render(<PromptInput busy={false} onSubmit={vi.fn()} />);

    instance.stdin.write("/");
    await nextFrame();
    expect(instance.lastFrame()).toContain("显示本帮助");

    instance.stdin.write("\x1b[27u");
    await nextFrame();
    expect(instance.lastFrame()).not.toContain("显示本帮助");

    instance.stdin.write("\t");
    await nextFrame();
    expect(instance.lastFrame()).toContain("显示本帮助");
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
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        store={store}
        panelHandlers={PANEL_HANDLERS}
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

  it("shows the API key setup hint and masks the input", async () => {
    const store = new TuiViewStore();
    store.initialize({ conversationId: "conversation-1", eventRevision: 0, messages: [] });
    store.setModelConfigured(false);
    store.setSetupStep("api-key");
    const instance = render(
      <App
        botName="coding.engineer"
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        store={store}
        panelHandlers={PANEL_HANDLERS}
        workspaceRoot="D:\\workspace"
      />,
    );
    await nextFrame();

    expect(instance.lastFrame()).toContain("输入 API Key");
    instance.stdin.write("sk-secret");
    await nextFrame();
    expect(instance.lastFrame()).not.toContain("sk-secret");
    expect(instance.lastFrame()).toContain("•");
    instance.unmount();
    store.dispose();
  });

  it("closes the command palette without cancelling the active run on Escape", async () => {
    const store = new TuiViewStore();
    store.initialize({ conversationId: "conversation-1", eventRevision: 0, messages: [] });
    store.beginRun();
    const onCancel = vi.fn();
    const instance = render(
      <App
        botName="coding.engineer"
        onCancel={onCancel}
        onSubmit={vi.fn()}
        store={store}
        panelHandlers={PANEL_HANDLERS}
        workspaceRoot="D:\\workspace"
      />,
    );
    await nextFrame();

    instance.stdin.write("/");
    await nextFrame();
    expect(instance.lastFrame()).toContain("显示本帮助");

    instance.stdin.write("\x1b[27u");
    await nextFrame();
    expect(instance.lastFrame()).not.toContain("显示本帮助");
    expect(onCancel).not.toHaveBeenCalled();

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
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        store={store}
        panelHandlers={PANEL_HANDLERS}
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
    const pointer = createPointerSource();
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
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        store={store}
        panelHandlers={PANEL_HANDLERS}
        pointerSource={pointer}
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

    for (let index = 0; index < 20; index += 1) pointer.emit(wheelEvent(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(instance.lastFrame()).toContain("line-19");

    for (let index = 0; index < 20; index += 1) pointer.emit(wheelEvent(-1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(instance.lastFrame()).toContain("line-0");

    instance.unmount();
    store.dispose();
  }, 45_000);

  it("keeps a manually scrolled history while a run streams", async () => {
    const store = new TuiViewStore();
    const pointer = createPointerSource();
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
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        store={store}
        panelHandlers={PANEL_HANDLERS}
        pointerSource={pointer}
        workspaceRoot="D:\\workspace"
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    store.beginRun();

    for (let index = 0; index < 20; index += 1) pointer.emit(wheelEvent(-1));
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
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        store={store}
        panelHandlers={PANEL_HANDLERS}
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
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        store={store}
        panelHandlers={PANEL_HANDLERS}
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

  it("copies the active selection with Ctrl+Shift+C and clears it with Escape", async () => {
    const store = new TuiViewStore();
    store.initialize({ conversationId: "conversation-1", eventRevision: 0, messages: [] });
    const selectionStore = new TuiSelectionStore();
    selectionStore.registerLine({ row: 0, left: 0, text: "hello" });
    selectionStore.commitFrame();
    selectionStore.begin({ row: 0, col: 0 });
    selectionStore.extend({ row: 0, col: 4 });
    const onCopy = vi.fn();
    const onClear = vi.fn();
    const instance = render(
      <App
        botName="coding.engineer"
        onCancel={vi.fn()}
        onClearSelection={onClear}
        onCopySelection={onCopy}
        onSubmit={vi.fn()}
        selectionStore={selectionStore}
        store={store}
        panelHandlers={PANEL_HANDLERS}
        workspaceRoot="D:\\workspace"
      />,
    );
    await nextFrame();
    onClear.mockClear();

    instance.stdin.write("\x1b[99;6u");
    await nextFrame();
    expect(onCopy).toHaveBeenCalledTimes(1);

    instance.stdin.write("\x1b[67;6u");
    await nextFrame();
    expect(onCopy).toHaveBeenCalledTimes(2);

    instance.stdin.write("\x1b[27u");
    await nextFrame();
    expect(onClear).toHaveBeenCalledTimes(1);

    instance.unmount();
    store.dispose();
  });

  it("selects all visible transcript lines with Ctrl+Shift+A", async () => {
    const store = new TuiViewStore();
    store.initialize({ conversationId: "conversation-1", eventRevision: 0, messages: [] });
    const onSelectAll = vi.fn();
    const instance = render(
      <App
        botName="coding.engineer"
        onCancel={vi.fn()}
        onSelectAll={onSelectAll}
        onSubmit={vi.fn()}
        store={store}
        panelHandlers={PANEL_HANDLERS}
        workspaceRoot="D:\\workspace"
      />,
    );
    await nextFrame();

    instance.stdin.write("\x1b[97;6u");
    await nextFrame();
    expect(onSelectAll).toHaveBeenCalledTimes(1);

    instance.unmount();
    store.dispose();
  });

  it("clears the selection when the transcript scrolls", async () => {
    const store = new TuiViewStore();
    store.initialize({ conversationId: "conversation-1", eventRevision: 0, messages: [] });
    const pointer = createPointerSource();
    const onClear = vi.fn();
    const instance = render(
      <App
        botName="coding.engineer"
        onCancel={vi.fn()}
        onClearSelection={onClear}
        onSubmit={vi.fn()}
        pointerSource={pointer}
        store={store}
        panelHandlers={PANEL_HANDLERS}
        workspaceRoot="D:\\workspace"
      />,
    );
    await nextFrame();
    onClear.mockClear();

    pointer.emit(wheelEvent(1));
    await nextFrame();
    expect(onClear).toHaveBeenCalledTimes(1);

    instance.unmount();
    store.dispose();
  });

  it("renders Read as a Claude-style summary without file contents", async () => {
    const instance = render(
      <Transcript
        view={{
          eventRevision: 0,
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              text: "",
              status: "complete",
              images: [],
              parts: [
                {
                  id: "tool-1",
                  kind: "tool",
                  toolCallId: "call-1",
                  toolName: "Read",
                  state: "completed",
                  input: { file_path: "src/a.ts" },
                  output: {
                    type: "text",
                    filePath: "src/a.ts",
                    content: "SECRET_CONTENT",
                    numLines: 42,
                    startLine: 1,
                    totalLines: 42,
                  },
                },
              ],
            },
          ],
        }}
        workspaceRoot="D:\\workspace"
      />,
    );
    await nextFrame();

    const frame = instance.lastFrame();
    expect(frame).toContain("Read(src/a.ts)");
    expect(frame).toContain("Read 42 lines");
    expect(frame).not.toContain("SECRET_CONTENT");
    instance.unmount();
  });

  it("keeps Grep matches collapsed until Ctrl+O expands the tool", async () => {
    const view = {
      eventRevision: 0,
      messages: [
        {
          id: "assistant-1",
          role: "assistant" as const,
          text: "",
          status: "complete" as const,
          images: [],
          parts: [
            {
              id: "tool-1",
              kind: "tool" as const,
              toolCallId: "call-1",
              toolName: "Grep",
              state: "completed" as const,
              input: { pattern: "needle", path: "src" },
              output: {
                type: "content",
                files: [
                  {
                    path: "src/a.ts",
                    lines: [{ lineNumber: 3, text: "needle found", kind: "match" }],
                  },
                ],
                totalMatches: 1,
                shownMatches: 1,
                truncated: false,
                lineNumbers: true,
              },
            },
          ],
        },
      ],
    };

    const collapsed = render(<Transcript view={view} workspaceRoot="D:\\workspace" />);
    await nextFrame();
    expect(collapsed.lastFrame()).toContain('Search(pattern: "needle", path: "src")');
    expect(collapsed.lastFrame()).toContain("Found 1 line");
    expect(collapsed.lastFrame()).toContain("ctrl+o to expand");
    expect(collapsed.lastFrame()).not.toContain("needle found");
    collapsed.unmount();

    const expanded = render(
      <Transcript expandThinking view={view} workspaceRoot="D:\\workspace" />,
    );
    await nextFrame();
    expect(expanded.lastFrame()).toContain("needle found");
    expanded.unmount();
  });

  it("renders RunCommand output under the result gutter", async () => {
    const instance = render(
      <Transcript
        view={{
          eventRevision: 0,
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              text: "",
              status: "complete",
              images: [],
              parts: [
                {
                  id: "tool-1",
                  kind: "tool",
                  toolCallId: "call-1",
                  toolName: "RunCommand",
                  state: "completed",
                  input: { command: "pnpm test" },
                  output: {
                    kind: "result",
                    result: {
                      stdout: "all tests passed",
                      stderr: "",
                      outcome: { type: "exit", exitCode: 0 },
                    },
                  },
                },
              ],
            },
          ],
        }}
        workspaceRoot="D:\\workspace"
      />,
    );
    await nextFrame();

    const frame = instance.lastFrame();
    expect(frame).toContain("Bash(pnpm test)");
    expect(frame).toContain("Done");
    expect(frame).toContain("all tests passed");
    instance.unmount();
  });

  it("renders Edit as Update with a condensed diff", async () => {
    const instance = render(
      <Transcript
        view={{
          eventRevision: 0,
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              text: "",
              status: "complete",
              images: [],
              parts: [
                {
                  id: "tool-1",
                  kind: "tool",
                  toolCallId: "call-1",
                  toolName: "Edit",
                  state: "completed",
                  input: { file_path: "src/a.ts", old_string: "old", new_string: "new" },
                  output: {
                    type: "edited",
                    filePath: "src/a.ts",
                    replacements: 1,
                    replaceAll: false,
                    diff: {
                      hunks: [
                        {
                          oldStart: 1,
                          oldLines: 2,
                          newStart: 1,
                          newLines: 2,
                          lines: [
                            { kind: "context", text: "keep" },
                            { kind: "removed", text: "old" },
                            { kind: "added", text: "new" },
                          ],
                        },
                      ],
                      additions: 1,
                      deletions: 1,
                      truncated: false,
                    },
                  },
                },
              ],
            },
          ],
        }}
        workspaceRoot="D:\\workspace"
      />,
    );
    await nextFrame();

    const frame = instance.lastFrame();
    expect(frame).toContain("Update(src/a.ts)");
    expect(frame).toContain("Added 1 line, removed 1 line");
    expect(frame).toContain("+1 -1");
    expect(frame).toContain("-old");
    expect(frame).toContain("+new");
    instance.unmount();
  });

  it("groups consecutive Read and Grep calls into one row until Ctrl+O", async () => {
    const view = {
      eventRevision: 0,
      messages: [
        {
          id: "assistant-1",
          role: "assistant" as const,
          text: "",
          status: "complete" as const,
          images: [],
          parts: [
            {
              id: "tool-1",
              kind: "tool" as const,
              toolCallId: "call-1",
              toolName: "Read",
              state: "completed" as const,
              input: { file_path: "src/a.ts" },
              output: {
                type: "text",
                filePath: "src/a.ts",
                content: "a",
                numLines: 10,
                startLine: 1,
                totalLines: 10,
              },
            },
            {
              id: "tool-2",
              kind: "tool" as const,
              toolCallId: "call-2",
              toolName: "Read",
              state: "completed" as const,
              input: { file_path: "src/b.ts" },
              output: {
                type: "text",
                filePath: "src/b.ts",
                content: "b",
                numLines: 20,
                startLine: 1,
                totalLines: 20,
              },
            },
            {
              id: "tool-3",
              kind: "tool" as const,
              toolCallId: "call-3",
              toolName: "Grep",
              state: "completed" as const,
              input: { pattern: "needle", path: "src" },
              output: {
                type: "content",
                files: [
                  {
                    path: "src/a.ts",
                    lines: [{ lineNumber: 3, text: "needle found", kind: "match" }],
                  },
                ],
                totalMatches: 1,
                shownMatches: 1,
                truncated: false,
                lineNumbers: true,
              },
            },
          ],
        },
      ],
    };

    const collapsed = render(<Transcript view={view} workspaceRoot="D:\\workspace" />);
    await nextFrame();
    expect(collapsed.lastFrame()).toContain("Read 2 files, searched 1 pattern");
    expect(collapsed.lastFrame()).not.toContain("Read(src/a.ts)");
    collapsed.unmount();

    const expanded = render(
      <Transcript expandThinking view={view} workspaceRoot="D:\\workspace" />,
    );
    await nextFrame();
    expect(expanded.lastFrame()).toContain("Read(src/a.ts)");
    expect(expanded.lastFrame()).toContain('Search(pattern: "needle", path: "src")');
    expanded.unmount();
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

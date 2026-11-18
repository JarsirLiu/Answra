import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../../src/tui/app/App";
import { TuiViewStore } from "../../../src/tui/app/viewStore";
import { createSelectionActions } from "../../../src/tui/interaction/selectionActions";
import { TuiSelectionStore } from "../../../src/tui/interaction/selectionStore";
import { createPointerSource, nextFrame, PANEL_HANDLERS, wheelEvent } from "../tuiTestHarness";

afterEach(() => {
  vi.useRealTimers();
});

describe("TUI transcript interaction", () => {
  it("shows command feedback after a conversation already has messages", async () => {
    const store = new TuiViewStore();
    store.initialize({
      conversationId: "conversation-1",
      eventRevision: 0,
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          text: "先前的回答",
          status: "complete",
          images: [],
          parts: [{ id: "part-1", kind: "text", text: "先前的回答", state: "completed" }],
        },
      ],
    });
    store.notify({ key: "login", text: "登录成功（user@example.com）。", tone: "success" });
    const instance = render(
      <App
        botName="coding.engineer"
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        panelHandlers={PANEL_HANDLERS}
        store={store}
        workspaceRoot="D:\\workspace"
      />,
    );
    await nextFrame();
    expect(instance.lastFrame()).toContain("登录成功（user@example.com）。");
    instance.unmount();
    store.dispose();
  });

  it("renders image attachments on user messages", async () => {
    const store = new TuiViewStore();
    store.initialize({
      conversationId: "conversation-image",
      eventRevision: 0,
      messages: [
        {
          id: "user-1",
          role: "user",
          text: "look",
          status: "complete",
          images: [{ name: "capture.png", dataUrl: "data:image/png;base64,QUJD" }],
          parts: [],
        },
      ],
    });
    const instance = render(
      <App
        botName="coding.engineer"
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        panelHandlers={PANEL_HANDLERS}
        store={store}
        workspaceRoot="D:\\workspace"
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(instance.lastFrame()).toContain("[Image #1]");
    expect(instance.lastFrame()).toContain("capture.png");
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

  it("keeps the selected text when the transcript scrolls", async () => {
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
    const pointer = createPointerSource();
    const selectionStore = new TuiSelectionStore();
    const instance = render(
      <App
        botName="coding.engineer"
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        pointerSource={pointer}
        selectionStore={selectionStore}
        store={store}
        panelHandlers={PANEL_HANDLERS}
        workspaceRoot="D:\\workspace"
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    selectionStore.commitFrame();
    selectionStore.selectAll();
    const selected = selectionStore.getSelectedText();
    expect(selected).not.toBe("");

    pointer.emit(wheelEvent(-1));
    await nextFrame();

    expect(selectionStore.hasSelection()).toBe(true);
    expect(selectionStore.getSelectedText()).toBe(selected);

    instance.unmount();
    store.dispose();
  });

  it("auto-scrolls while a drag selection stays past the viewport edge", async () => {
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
    const pointer = createPointerSource();
    const selectionStore = new TuiSelectionStore();
    const actions = createSelectionActions(selectionStore, { write: vi.fn() });
    pointer.subscribe((event) => actions.handlePointer(event));
    const instance = render(
      <App
        botName="coding.engineer"
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        pointerSource={pointer}
        selectionStore={selectionStore}
        store={store}
        panelHandlers={PANEL_HANDLERS}
        workspaceRoot="D:\\workspace"
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    selectionStore.commitFrame();

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    pointer.emit({ kind: "press", point: { row: 1, col: 0 } });
    pointer.emit({ kind: "drag", point: { row: 0, col: 0 } });
    const afterFirstTick = selectionStore.getBounds()?.start.row ?? 0;

    vi.advanceTimersByTime(50);
    expect(selectionStore.getBounds()?.start.row ?? afterFirstTick).toBeLessThanOrEqual(
      afterFirstTick - 2,
    );

    pointer.emit({ kind: "release", point: { row: 0, col: 0 } });
    expect(selectionStore.hasSelection()).toBe(true);
    await vi.waitFor(
      () => {
        selectionStore.commitFrame();
        expect(selectionStore.getSelectedText()).toContain("line-");
      },
      { timeout: 5_000 },
    );

    instance.unmount();
    store.dispose();
  });
});

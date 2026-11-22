import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../../src/tui/app/App";
import { TuiViewStore } from "../../../src/tui/app/viewStore";
import { nextFrame, PANEL_HANDLERS } from "../tuiTestHarness";

describe("TUI thinking", () => {
  it("collapses thinking until Ctrl+O enters the detailed transcript", async () => {
    const store = new TuiViewStore();
    store.initialize({
      conversationId: "conversation-1",
      eventRevision: 0,
      lastSeq: 0,
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

  it("shows only the latest turn's thinking until Ctrl+O shows the full transcript", async () => {
    const store = new TuiViewStore();
    store.initialize({
      conversationId: "conversation-1",
      eventRevision: 0,
      lastSeq: 0,
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
});

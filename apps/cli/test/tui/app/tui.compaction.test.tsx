import { render as inkRender } from "ink";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../../src/tui/app/App";
import { TuiViewStore } from "../../../src/tui/app/viewStore";
import { CursorProbeStdin, CursorProbeStdout, nextFrame, PANEL_HANDLERS } from "../tuiTestHarness";

describe("TUI compaction", () => {
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
});

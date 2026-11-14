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

  it("shows Claude-style summary metadata before expanding the summary with Ctrl+O", async () => {
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
      contextCompactionBoundaries: [
        {
          id: "compaction:2026-11-14T10:00:01.000Z:message-1",
          throughMessageId: "message-1",
          createdAt: "2026-11-14T10:00:01.000Z",
          summary: "## 当前目标\n继续实现压缩",
          summarizedMessages: 8,
          instructions: "重点保留数据库迁移决定",
        },
      ],
    });
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

    const collapsed = stdout.chunks.join("");
    expect(collapsed).toContain("Summarized conversation");
    expect(collapsed).toContain("Summarized 8 messages up to this point");
    expect(collapsed).toContain("Context: “重点保留数据库迁移决定”");
    expect(collapsed).toContain("(ctrl+o to expand history)");
    expect(collapsed).not.toContain("继续实现压缩");

    stdin.write("\u000f");
    await nextFrame();
    await instance.waitUntilRenderFlush();

    const frame = stdout.chunks.join("");
    expect(frame).toContain("继续实现压缩");
    expect(frame).toContain("Showing detailed transcript · ctrl+o to toggle");
    instance.unmount();
    store.dispose();
  });

  it("uses Claude's Compact summary branch when a boundary has no manual metadata", async () => {
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
      contextCompactionBoundaries: [
        {
          id: "compaction:2026-11-14T10:00:01.000Z:message-1",
          throughMessageId: "message-1",
          createdAt: "2026-11-14T10:00:01.000Z",
          summary: "## 当前目标\n继续实现压缩",
          summarizedMessages: 8,
        },
      ],
    });
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

    const collapsed = stdout.chunks.join("");
    expect(collapsed).toContain("Compact summary");
    expect(collapsed).not.toContain("Summarized conversation");
    expect(collapsed).not.toContain("Summarized 8 messages up to this point");
    expect(collapsed).toContain("(ctrl+o to expand)");
    expect(collapsed).not.toContain("继续实现压缩");

    stdin.write("\u000f");
    await nextFrame();
    await instance.waitUntilRenderFlush();

    expect(stdout.chunks.join("")).toContain("继续实现压缩");
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

  it("shows context usage in the status line and the latest tool cleanup", async () => {
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
      contextUsage: {
        contextWindow: 256_000,
        usedTokens: 45_000,
        inputLimit: 216_000,
        compactAt: 216_000,
        pruneAt: 172_000,
        pruneTarget: 40_000,
        updatedAt: "2026-11-14T10:00:00.000Z",
      },
      contextPruning: {
        trigger: "auto",
        prunedCount: 2,
        savedTokens: 30_000,
        updatedAt: "2026-11-14T10:00:00.000Z",
      },
    });
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
    expect(frame).toContain("ctx 45k/216k");
    expect(frame).toContain("30k token");
    instance.unmount();
    store.dispose();
  });
});

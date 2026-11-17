import { render as inkRender } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../../src/tui/app/App";
import { TuiViewStore } from "../../../src/tui/app/viewStore";
import { PromptInput } from "../../../src/tui/composer/PromptInput";
import { Welcome } from "../../../src/tui/transcript/Transcript";
import {
  CursorProbeStdin,
  CursorProbeStdout,
  lastParkedCursorColumn,
  nextFrame,
  PANEL_HANDLERS,
} from "../tuiTestHarness";

describe("TUI rendering", () => {
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

  it("parks the native terminal cursor at the input caret", async () => {
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

    expect(lastParkedCursorColumn(stdout.chunks.join(""))).toBe(5);
    instance.unmount();
  });

  it("keeps rendering streamed assistant text while the input cursor is parked", async () => {
    const store = new TuiViewStore();
    store.initialize({
      conversationId: "conversation-1",
      eventRevision: 1,
      messages: [
        { id: "user-1", role: "user", text: "question", images: [], status: "complete" },
        { id: "run-1", role: "assistant", text: "", images: [], status: "streaming" },
      ],
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
    store.applyEvent({
      schemaVersion: 1,
      eventId: "event-2",
      conversationId: "conversation-1",
      runId: "run-1",
      attemptId: "run-1:attempt:1",
      sequence: 2,
      aggregateRevision: 2,
      producerId: "test",
      occurredAt: "2026-11-13T00:00:00.000Z",
      event: { type: "text-delta", partId: "text-1", delta: "assistant-visible-text" },
    });
    store.flush();
    await nextFrame();
    await instance.waitUntilRenderFlush();

    expect(stdout.chunks.join("")).toContain("assistant-visible-text");
    instance.unmount();
    store.dispose();
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
});

import { render as inkRender } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../../src/tui/app/App";
import { TuiViewStore } from "../../../src/tui/app/viewStore";
import { liveFrame } from "../../frameFixtures";
import { CursorProbeStdin, CursorProbeStdout, nextFrame, PANEL_HANDLERS } from "../tuiTestHarness";

const STREAM_DELTAS = 10;

describe("TUI streaming", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not repaint the run spinner on every streamed text delta", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const store = new TuiViewStore();
    store.initialize({
      conversationId: "conversation-1",
      lastSeq: 0,
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
    const frameStart = stdout.chunks.length;

    for (let index = 0; index < STREAM_DELTAS; index += 1) {
      store.applyLiveFrame(
        liveFrame(
          { type: "text-delta", partId: "text-1", delta: `- item ${index}\n` },
          { messageId: "run-1" },
        ),
      );
      store.flushLive();
      await nextFrame();
      await instance.waitUntilRenderFlush();
    }

    const streamed = stdout.chunks.slice(frameStart).join("");
    expect(streamed).toContain("• item 0");
    expect(streamed).not.toContain(`${String.fromCharCode(27)}[1;1H${String.fromCharCode(27)}[J`);
    expect(streamed.match(/esc to interrupt/g)?.length ?? 0).toBe(0);

    instance.unmount();
    store.dispose();
  });
});

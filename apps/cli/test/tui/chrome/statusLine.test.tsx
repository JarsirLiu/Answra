import { render } from "ink";
import { describe, expect, it } from "vitest";
import { StatusLine } from "../../../src/tui/chrome/StatusLine";
import { CursorProbeStdin, CursorProbeStdout, nextFrame } from "../tuiTestHarness";

const USAGE = {
  contextWindow: 258_000,
  usedTokens: 45_000,
  inputLimit: 216_000,
  compactAt: 216_000,
  pruneAt: 172_000,
  pruneTarget: 172_000,
  updatedAt: "2026-11-16T00:00:00.000Z",
};

async function renderStatusLine(model: string) {
  const stdout = new CursorProbeStdout();
  const instance = render(
    <StatusLine
      botName="coding.engineer"
      contextUsage={USAGE}
      model={model}
      phase="idle"
      workspaceRoot="D:\\codespace\\exam-assistant\\apps\\cli"
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new CursorProbeStdin() as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  await nextFrame();
  await instance.waitUntilRenderFlush();
  const frame = stdout.chunks.join("");
  instance.unmount();
  return frame;
}

describe("status line", () => {
  it("shows a compact context percentage instead of a truncated token pair", async () => {
    const frame = await renderStatusLine("deepseek-v4.1-flash-1017");

    expect(frame).toContain("ctx 21%");
    expect(frame).not.toContain("45k/216k");
    expect(frame).toContain("idle");
  });

  it("keeps the context percentage when the model name is too long", async () => {
    const frame = await renderStatusLine("m".repeat(200));

    expect(frame).toContain("ctx 21%");
    expect(frame).toContain("idle");
  });
});

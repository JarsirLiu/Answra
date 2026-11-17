import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { PromptInput } from "../../../src/tui/composer/PromptInput";
import { nextFrame } from "../tuiTestHarness";

describe("TUI composer", () => {
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

  it("puts recently executed commands first in the empty slash palette", async () => {
    const instance = render(<PromptInput busy={false} onSubmit={vi.fn()} />);

    instance.stdin.write("/model");
    await nextFrame();
    instance.stdin.write("\r");
    await nextFrame();
    instance.stdin.write("/");
    await nextFrame();

    const lines = (instance.lastFrame() ?? "").split("\n");
    const modelLine = lines.findIndex((line) => line.includes("/model"));
    const helpLine = lines.findIndex((line) => line.includes("/help"));
    expect(modelLine).toBeGreaterThanOrEqual(0);
    expect(modelLine).toBeLessThan(helpLine);
    instance.unmount();
  });

  it("shows argument hints until real arguments are typed", async () => {
    const instance = render(<PromptInput busy={false} onSubmit={vi.fn()} />);

    instance.stdin.write("/compact");
    await nextFrame();
    expect(instance.lastFrame()).toContain("[instructions]");

    instance.stdin.write(" 保留迁移");
    await nextFrame();
    expect(instance.lastFrame()).not.toContain("[instructions]");
    instance.unmount();
  });

  it("does not show the native terminal cursor over the input border", async () => {
    const instance = render(<PromptInput busy={false} onSubmit={vi.fn()} />);

    instance.stdin.write("/resume ");
    await nextFrame();

    expect(instance.lastFrame()).not.toContain("\u001b[?25h");
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
    expect(instance.lastFrame()).toContain("Ctrl-C");
    instance.unmount();
  });

  it("attaches a clipboard image with Ctrl-V and submits an image-only prompt", async () => {
    const image = { name: "clipboard.png", dataUrl: "data:image/png;base64,QUJD" };
    const readClipboard = vi.fn(async () => [image]);
    const readPath = vi.fn(async () => image);
    const onSubmit = vi.fn();
    const instance = render(
      <PromptInput busy={false} imageReader={{ readClipboard, readPath }} onSubmit={onSubmit} />,
    );

    instance.stdin.write("\u0016");
    await nextFrame();

    expect(readClipboard).toHaveBeenCalledTimes(1);
    expect(instance.lastFrame()).toContain("[Image #1]");
    expect(instance.lastFrame()).not.toContain("clipboard.png");

    instance.stdin.write("\r");
    await nextFrame();
    expect(onSubmit).toHaveBeenCalledWith("[Image #1]", [image]);
    instance.unmount();
  });

  it("attaches a clipboard image with Alt-V", async () => {
    const image = { name: "clipboard.png", dataUrl: "data:image/png;base64,QUJD" };
    const readClipboard = vi.fn(async () => [image]);
    const readPath = vi.fn(async () => image);
    const instance = render(
      <PromptInput busy={false} imageReader={{ readClipboard, readPath }} onSubmit={vi.fn()} />,
    );

    instance.stdin.write("\u001bv");
    await nextFrame();

    expect(readClipboard).toHaveBeenCalledTimes(1);
    expect(instance.lastFrame()).toContain("[Image #1]");
    instance.unmount();
  });

  it("keeps the inline reference in the submitted text", async () => {
    const image = { name: "capture.png", dataUrl: "data:image/png;base64,QUJD" };
    const readClipboard = vi.fn(async () => []);
    const readPath = vi.fn(async () => image);
    const onSubmit = vi.fn();
    const instance = render(
      <PromptInput busy={false} imageReader={{ readClipboard, readPath }} onSubmit={onSubmit} />,
    );

    instance.stdin.write("\x1b[200~C:\\shots\\capture.png\x1b[201~");
    await nextFrame();
    instance.stdin.write("describe this");
    await nextFrame();
    instance.stdin.write("\r");
    await nextFrame();

    expect(onSubmit).toHaveBeenCalledWith("[Image #1] describe this", [image]);
    instance.unmount();
  });

  it("reads a pasted image path and drops the image when its reference is deleted", async () => {
    const image = { name: "capture.png", dataUrl: "data:image/png;base64,QUJD" };
    const readClipboard = vi.fn(async () => []);
    const readPath = vi.fn(async () => image);
    const onSubmit = vi.fn();
    const instance = render(
      <PromptInput busy={false} imageReader={{ readClipboard, readPath }} onSubmit={onSubmit} />,
    );

    instance.stdin.write("\x1b[200~C:\\shots\\capture.png\x1b[201~");
    await nextFrame();

    expect(readPath).toHaveBeenCalledWith("C:\\shots\\capture.png");
    expect(instance.lastFrame()).toContain("[Image #1]");

    instance.stdin.write("\u007f");
    await nextFrame();
    expect(instance.lastFrame()).not.toContain("[Image #");

    instance.stdin.write("describe the workspace");
    await nextFrame();
    instance.stdin.write("\r");
    await nextFrame();
    expect(onSubmit).toHaveBeenCalledWith("describe the workspace");
    instance.unmount();
  });

  it("shows the reading state only when clipboard reading is slow", async () => {
    const image = { name: "clipboard.png", dataUrl: "data:image/png;base64,QUJD" };
    let release: ((images: readonly (typeof image)[]) => void) | undefined;
    const readClipboard = vi.fn(
      () =>
        new Promise<readonly (typeof image)[]>((resolve) => {
          release = resolve;
        }),
    );
    const instance = render(
      <PromptInput
        busy={false}
        imageReader={{ readClipboard, readPath: vi.fn(async () => image) }}
        onSubmit={vi.fn()}
      />,
    );

    instance.stdin.write("\u0016");
    await nextFrame();
    expect(instance.lastFrame()).not.toContain("正在读取图片");

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(instance.lastFrame()).toContain("正在读取图片");

    release?.([image]);
    await nextFrame();
    await nextFrame();
    expect(instance.lastFrame()).not.toContain("正在读取图片");
    expect(instance.lastFrame()).toContain("[Image #1]");
    instance.unmount();
  });
});

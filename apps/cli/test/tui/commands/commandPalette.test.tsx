import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "../../../src/tui/commands/CommandPalette";
import { findTuiCommand, TUI_COMMANDS } from "../../../src/tui/commands/catalog";
import { PromptInput } from "../../../src/tui/composer/PromptInput";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("command palette execution", () => {
  it("executes the selected command with Enter from the bare slash", async () => {
    const onSubmit = vi.fn();
    const instance = render(<PromptInput busy={false} onSubmit={onSubmit} />);

    instance.stdin.write("/");
    await tick();
    instance.stdin.write("\r");
    await tick();

    expect(onSubmit).toHaveBeenCalledWith("/help");
    instance.unmount();
  });

  it("wraps the command selection upward", async () => {
    const onSubmit = vi.fn();
    const instance = render(<PromptInput busy={false} onSubmit={onSubmit} />);

    instance.stdin.write("/");
    await tick();
    instance.stdin.write("\u001b[A");
    await tick();
    instance.stdin.write("\r");
    await tick();

    expect(onSubmit).toHaveBeenCalledWith("/exit");
    instance.unmount();
  });

  it("still completes a prefix before submitting", async () => {
    const onSubmit = vi.fn();
    const instance = render(<PromptInput busy={false} onSubmit={onSubmit} />);

    instance.stdin.write("/mo");
    await tick();
    instance.stdin.write("\r");
    await tick();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain("/model");
    instance.unmount();
  });

  it("aligns descriptions and caps visible rows", () => {
    const commands = TUI_COMMANDS.slice(0, 7);
    const instance = render(<CommandPalette columns={50} commands={commands} selectedIndex={0} />);
    const lines = (instance.lastFrame() ?? "").split("\n").filter((line) => line.length > 0);

    expect(lines).toHaveLength(5);
    expect(lines[0]?.indexOf("显示本帮助")).toBe(lines[1]?.indexOf("清空当前会话 transcript"));
    instance.unmount();
  });

  it("truncates rows to the available terminal width", () => {
    const commands = ["help", "compact", "config"].map((name) => {
      const command = findTuiCommand(name);
      if (command === undefined) throw new Error(`missing command: ${name}`);
      return command;
    });
    const instance = render(<CommandPalette columns={24} commands={commands} selectedIndex={0} />);
    const lines = (instance.lastFrame() ?? "").split("\n").filter((line) => line.length > 0);

    expect(lines.every((line) => stringWidth(line) <= 24)).toBe(true);
    instance.unmount();
  });
});

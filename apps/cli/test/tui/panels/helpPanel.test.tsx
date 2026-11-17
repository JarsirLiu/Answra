import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { HelpPanel } from "../../../src/tui/panels/HelpPanel";

describe("HelpPanel", () => {
  it("renders catalog help lines and closes with Escape", async () => {
    const close = vi.fn();
    const instance = render(<HelpPanel close={close} />);

    await vi.waitFor(() => expect(instance.lastFrame()).toContain("本地命令："));
    expect(instance.lastFrame()).toContain("/status");
    expect(instance.lastFrame()).toContain("/config");

    instance.stdin.write("\u001b");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    instance.unmount();
  });

  it("closes with Enter", async () => {
    const close = vi.fn();
    const instance = render(<HelpPanel close={close} />);

    instance.stdin.write("\r");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    instance.unmount();
  });
});

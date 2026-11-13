import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { PromptInput } from "../src/tui/composer/PromptInput";

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
});

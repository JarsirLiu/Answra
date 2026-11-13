import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { ModelPicker } from "../../../src/tui/commands/ModelPicker";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ModelPicker", () => {
  it("shows the current model first and switches the selection", async () => {
    const select = vi.fn(async () => {});
    const close = vi.fn();
    const instance = render(
      <ModelPicker
        close={close}
        load={async () => ({ current: "a", models: ["a", "b"] })}
        select={select}
      />,
    );
    await tick();

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("Select model");
    expect(frame).toContain("Current model");
    expect(frame).toContain("a");
    expect(frame).toContain("b");

    instance.stdin.write("\u001b[B");
    await tick();
    instance.stdin.write("\r");
    await tick();

    expect(select).toHaveBeenCalledWith("b");
    expect(close).toHaveBeenCalledTimes(1);
    instance.unmount();
  });

  it("keeps the current model and explains the manual fallback on catalog errors", async () => {
    const instance = render(
      <ModelPicker
        close={vi.fn()}
        load={async () => ({ current: "a", models: [], error: "HTTP 404" })}
        select={vi.fn()}
      />,
    );
    await tick();

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("HTTP 404");
    expect(frame).toContain("a");
    expect(frame).toContain("可用 /model <ID> 直接切换");
    instance.unmount();
  });

  it("truncates long model lists and reports the hidden count", async () => {
    const models = Array.from({ length: 12 }, (_, index) => `model-${index}`);
    const instance = render(
      <ModelPicker
        close={vi.fn()}
        load={async () => ({ current: "current", models })}
        select={vi.fn()}
      />,
    );
    await tick();

    expect(instance.lastFrame()).toContain("and 3 more…");
    instance.unmount();
  });
});

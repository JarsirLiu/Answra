import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { ModelPicker } from "../../../src/tui/panels/ModelPicker";

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
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("Current model"));

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
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("HTTP 404"));

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("HTTP 404");
    expect(frame).toContain("a");
    expect(frame).toContain("按 Tab 输入模型 ID");
    instance.unmount();
  });

  it("accepts a custom model id without relying on the catalog", async () => {
    const select = vi.fn(async () => {});
    const close = vi.fn();
    const instance = render(
      <ModelPicker
        close={close}
        load={async () => ({ current: "a", models: ["a", "b"] })}
        select={select}
      />,
    );
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("Current model"));

    instance.stdin.write("\t");
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("当前模型：a"));
    instance.stdin.write("\u0015");
    await tick();
    instance.stdin.write("custom-model");
    await tick();
    instance.stdin.write("\r");

    await vi.waitFor(() => expect(select).toHaveBeenCalledWith("custom-model"));
    expect(close).toHaveBeenCalledTimes(1);
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
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("↓ 3 more…"));

    expect(instance.lastFrame()).toContain("↓ 3 more…");
    instance.unmount();
  });

  it("keeps the focused model inside the visible window while scrolling", async () => {
    const models = Array.from({ length: 15 }, (_, index) => `model-${index}`);
    const instance = render(
      <ModelPicker
        close={vi.fn()}
        load={async () => ({ current: "current", models })}
        select={vi.fn()}
      />,
    );
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("model-0"));

    for (let index = 0; index < 11; index += 1) {
      instance.stdin.write("\u001b[B");
      await vi.waitFor(() => expect(instance.lastFrame()).toContain(`\u276f   model-${index}`));
    }

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("↑ 2 more…");
    expect(frame).toContain("↓ 4 more…");
    expect(frame).toContain("model-10");
    expect(frame).not.toContain("model-0");
    instance.unmount();
  });
});

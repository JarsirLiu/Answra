import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { ConfigPanel } from "../../../src/tui/commands/ConfigPanel";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

function basePanel(
  overrides: Partial<{
    load: () => Promise<{
      baseUrl: string;
      chatModel: string;
      answerModel?: string;
      apiKey: string;
    }>;
    loadModels: () => Promise<{ current: string; models: readonly string[]; error?: string }>;
    save: (input: unknown) => Promise<void>;
    close: (reason?: "saved" | "dismissed") => void;
  }> = {},
) {
  return {
    close: vi.fn(),
    load: async () => ({
      baseUrl: "http://127.0.0.1:1234/v1",
      chatModel: "qwen",
      answerModel: "qwen-vl",
      apiKey: "sk-existing-1234",
    }),
    loadModels: async () => ({ current: "qwen", models: ["qwen", "other"] }),
    save: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("ConfigPanel", () => {
  it("shows a searchable settings list with masked API key state", async () => {
    const props = basePanel();
    const instance = render(<ConfigPanel {...props} />);
    await tick();

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("模型配置");
    expect(frame).toContain("搜索设置…");
    expect(frame).toContain("Base URL");
    expect(frame).toContain("API Key");
    expect(frame).toContain("已保存");
    expect(frame).toContain("••••1234");
    expect(frame).toContain("Chat 模型");
    expect(frame).toContain("qwen");
    expect(frame).toContain("Answer 模型");
    expect(frame).toContain("qwen-vl");
    expect(frame).not.toContain("›");
    expect(frame).not.toContain("sk-existing-1234");
    instance.unmount();
  });

  it("filters settings from search mode and opens the focused row with Enter", async () => {
    const props = basePanel();
    const instance = render(<ConfigPanel {...props} />);
    await tick();

    instance.stdin.write("api");
    await tick();
    const filtered = instance.lastFrame() ?? "";
    expect(filtered).toContain("API Key");
    expect(filtered).not.toContain("Base URL");

    instance.stdin.write("\r");
    await tick();
    expect(instance.lastFrame()).toContain("Ctrl+R 显示/隐藏 Key");
    instance.stdin.write("\r");
    await tick();

    expect(instance.lastFrame()).toContain("Ctrl+R 显示/隐藏");
    instance.unmount();
  });

  it("opens the focused row with Right arrow and ignores Space", async () => {
    const props = basePanel();
    const instance = render(<ConfigPanel {...props} />);
    await tick();

    instance.stdin.write("\u001b[B");
    await tick();
    instance.stdin.write("\u001b[C");
    await tick();
    expect(instance.lastFrame()).toContain("Enter 确认 · Esc 取消编辑");

    instance.stdin.write(" ");
    await tick();
    expect(instance.lastFrame()).toContain("Enter 确认 · Esc 取消编辑");
    instance.unmount();
  });

  it("edits the API key and saves it as a set intent", async () => {
    const props = basePanel();
    const instance = render(<ConfigPanel {...props} />);
    await tick();

    instance.stdin.write("\r");
    await tick();
    instance.stdin.write("\u001b[B");
    await tick();
    expect(instance.lastFrame()).toContain("Ctrl+R 显示/隐藏 Key");
    instance.stdin.write("\r");
    await tick();
    instance.stdin.write("\u0015");
    await tick();
    instance.stdin.write("sk-new");
    await tick();
    instance.stdin.write("\r");
    await tick();
    instance.stdin.write("\u0013");
    await tick();

    expect(props.save).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:1234/v1",
      chatModel: "qwen",
      answerModel: "qwen-vl",
      apiKey: { kind: "set", value: "sk-new" },
    });
    expect(props.close).toHaveBeenCalledWith("saved");
    instance.unmount();
  });

  it("can reveal the saved API key with Ctrl+R from the list", async () => {
    const props = basePanel();
    const instance = render(<ConfigPanel {...props} />);
    await tick();

    instance.stdin.write("\r");
    await tick();
    instance.stdin.write("\u001b[B");
    await tick();
    instance.stdin.write("\u0012");
    await tick();
    expect(instance.lastFrame()).toContain("sk-existing-1234");

    instance.stdin.write("\u001b[B");
    await tick();
    expect(instance.lastFrame()).not.toContain("sk-existing-1234");
    instance.unmount();
  });

  it("can reveal the saved API key with Ctrl+R while editing", async () => {
    const props = basePanel();
    const instance = render(<ConfigPanel {...props} />);
    await tick();

    instance.stdin.write("\r");
    await tick();
    instance.stdin.write("\u001b[B");
    await tick();
    instance.stdin.write("\r");
    await tick();
    expect(instance.lastFrame()).not.toContain("sk-existing-1234");

    instance.stdin.write("\u0012");
    await tick();
    expect(instance.lastFrame()).toContain("sk-existing-1234");
    instance.unmount();
  });

  it("closes with the dismissed reason when Escape leaves the list", async () => {
    const props = basePanel();
    const instance = render(<ConfigPanel {...props} />);
    await tick();

    instance.stdin.write("\r");
    await settle();
    expect(instance.lastFrame()).toContain("Enter/→ 修改");
    instance.stdin.write("\u001b");
    await settle();

    expect(props.close).toHaveBeenCalledWith("dismissed");
    instance.unmount();
  });

  it("keeps validation errors in the panel", async () => {
    const props = basePanel({
      load: async () => ({ baseUrl: "", chatModel: "", apiKey: "" }),
    });
    const instance = render(<ConfigPanel {...props} />);
    await tick();

    instance.stdin.write("\r");
    await tick();
    instance.stdin.write("\u0013");
    await tick();

    expect(instance.lastFrame()).toContain("请填写 Base URL。");
    expect(props.save).not.toHaveBeenCalled();
    expect(props.close).not.toHaveBeenCalled();
    instance.unmount();
  });

  it("selects a chat model from the embedded model menu", async () => {
    const props = basePanel();
    const instance = render(<ConfigPanel {...props} />);
    await tick();

    instance.stdin.write("\r");
    await tick();
    instance.stdin.write("\u001b[B");
    await tick();
    instance.stdin.write("\u001b[B");
    await tick();
    instance.stdin.write("\r");
    await tick();

    const menu = instance.lastFrame() ?? "";
    expect(menu).toContain("Select model");
    expect(menu).toContain("Current model");
    expect(menu).toContain("other");

    instance.stdin.write("\u001b[B");
    await tick();
    instance.stdin.write("\r");
    await tick();
    instance.stdin.write("\u0013");
    await tick();

    expect(props.save).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:1234/v1",
      chatModel: "other",
      answerModel: "qwen-vl",
      apiKey: { kind: "keep" },
    });
    instance.unmount();
  });

  it("selects the answer fallback from the model menu", async () => {
    const props = basePanel();
    const instance = render(<ConfigPanel {...props} />);
    await tick();

    instance.stdin.write("\r");
    await tick();
    instance.stdin.write("\u001b[B");
    await tick();
    instance.stdin.write("\u001b[B");
    await tick();
    instance.stdin.write("\u001b[B");
    await tick();
    instance.stdin.write("\r");
    await tick();
    expect(instance.lastFrame()).toContain("与 Chat 相同");

    instance.stdin.write("\r");
    await tick();
    instance.stdin.write("\u0013");
    await tick();

    expect(props.save).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:1234/v1",
      chatModel: "qwen",
      apiKey: { kind: "keep" },
    });
    instance.unmount();
  });

  it("falls back to manual model input when the catalog is unavailable", async () => {
    const props = basePanel({
      loadModels: async () => ({ current: "qwen", models: [], error: "HTTP 404" }),
    });
    const instance = render(<ConfigPanel {...props} />);
    await tick();

    instance.stdin.write("\r");
    await tick();
    instance.stdin.write("\u001b[B");
    await tick();
    instance.stdin.write("\u001b[B");
    await tick();
    instance.stdin.write("\r");
    await tick();
    expect(instance.lastFrame()).toContain("HTTP 404");

    instance.stdin.write("\u001b[B");
    await tick();
    instance.stdin.write("\r");
    await tick();
    instance.stdin.write("\u0015");
    await tick();
    instance.stdin.write("custom-model");
    await tick();
    instance.stdin.write("\r");
    await tick();
    instance.stdin.write("\u0013");
    await tick();

    expect(props.save).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:1234/v1",
      chatModel: "custom-model",
      answerModel: "qwen-vl",
      apiKey: { kind: "keep" },
    });
    instance.unmount();
  });
});

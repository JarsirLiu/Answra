import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { ConfigPanel } from "../../../src/tui/panels/ConfigPanel";

type ConfigPanelInstance = ReturnType<typeof render>;

const LIST_FOOTER = "Ctrl+S 保存";
const API_KEY_ROW = "Ctrl+R 显示/隐藏 Key";
const EDITING_HINT = "Enter 确认 · Esc 取消编辑";
const API_KEY_EDITING_HINT = "Enter 确认 · Ctrl+R 显示/隐藏 · Esc 取消编辑";

function waitForFrame(
  instance: ConfigPanelInstance,
  assertion: (frame: string) => void,
): Promise<void> {
  return vi.waitFor(() => assertion(instance.lastFrame() ?? ""), { timeout: 5_000 });
}

function press(instance: ConfigPanelInstance, input: string, expected: string): Promise<void> {
  instance.stdin.write(input);
  return waitForFrame(instance, (frame) => expect(frame).toContain(expected));
}

function waitForFocus(instance: ConfigPanelInstance, label: string): Promise<void> {
  return waitForFrame(instance, (frame) => expect(frame).toMatch(new RegExp(`[>›]\\s*${label}`)));
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
    save: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("ConfigPanel", () => {
  it("shows a searchable settings list with masked API key state", async () => {
    const props = basePanel();
    const instance = render(<ConfigPanel {...props} />);
    await waitForFrame(instance, (frame) => expect(frame).toContain("Base URL"));

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
    await waitForFrame(instance, (frame) => expect(frame).toContain("Base URL"));

    instance.stdin.write("api");
    await waitForFrame(instance, (frame) => {
      expect(frame).toContain("API Key");
      expect(frame).not.toContain("Base URL");
    });

    await press(instance, "\r", API_KEY_ROW);
    await press(instance, "\r", API_KEY_EDITING_HINT);
    instance.unmount();
  });

  it("opens the focused row with Right arrow and ignores Space", async () => {
    const props = basePanel();
    const instance = render(<ConfigPanel {...props} />);
    await waitForFrame(instance, (frame) => expect(frame).toContain("Base URL"));

    await press(instance, "\u001b[B", LIST_FOOTER);
    await press(instance, "\u001b[C", EDITING_HINT);

    instance.stdin.write(" ");
    await settle();
    expect(instance.lastFrame()).toContain(EDITING_HINT);
    instance.unmount();
  });

  it("edits the API key and saves it as a set intent", async () => {
    const props = basePanel();
    const instance = render(<ConfigPanel {...props} />);
    await waitForFrame(instance, (frame) => expect(frame).toContain("Base URL"));

    await press(instance, "\r", LIST_FOOTER);
    await press(instance, "\u001b[B", API_KEY_ROW);
    await press(instance, "\r", API_KEY_EDITING_HINT);
    instance.stdin.write("\u0015");
    await waitForFrame(instance, (frame) => expect(frame).not.toContain("•"));
    instance.stdin.write("sk-new");
    await waitForFrame(instance, (frame) => expect(frame).toMatch(/•{6}/));
    await press(instance, "\r", API_KEY_ROW);
    instance.stdin.write("\u0013");

    await vi.waitFor(
      () => {
        expect(props.save).toHaveBeenCalledWith({
          baseUrl: "http://127.0.0.1:1234/v1",
          chatModel: "qwen",
          answerModel: "qwen-vl",
          apiKey: { kind: "set", value: "sk-new" },
        });
        expect(props.close).toHaveBeenCalledWith("saved");
      },
      { timeout: 5_000 },
    );
    instance.unmount();
  });

  it("can reveal the saved API key with Ctrl+R from the list", async () => {
    const props = basePanel();
    const instance = render(<ConfigPanel {...props} />);
    await waitForFrame(instance, (frame) => expect(frame).toContain("Base URL"));

    await press(instance, "\r", LIST_FOOTER);
    await press(instance, "\u001b[B", API_KEY_ROW);
    await press(instance, "\u0012", "sk-existing-1234");

    instance.stdin.write("\u001b[B");
    await waitForFrame(instance, (frame) => expect(frame).not.toContain("sk-existing-1234"));
    instance.unmount();
  });

  it("can reveal the saved API key with Ctrl+R while editing", async () => {
    const props = basePanel();
    const instance = render(<ConfigPanel {...props} />);
    await waitForFrame(instance, (frame) => expect(frame).toContain("Base URL"));

    await press(instance, "\r", LIST_FOOTER);
    await press(instance, "\u001b[B", API_KEY_ROW);
    await press(instance, "\r", API_KEY_EDITING_HINT);
    expect(instance.lastFrame()).not.toContain("sk-existing-1234");

    await press(instance, "\u0012", "sk-existing-1234");
    instance.unmount();
  });

  it("closes with the dismissed reason when Escape leaves the list", async () => {
    const props = basePanel();
    const instance = render(<ConfigPanel {...props} />);
    await waitForFrame(instance, (frame) => expect(frame).toContain("Base URL"));

    await press(instance, "\r", LIST_FOOTER);
    instance.stdin.write("\u001b");

    await vi.waitFor(() => expect(props.close).toHaveBeenCalledWith("dismissed"), {
      timeout: 5_000,
    });
    instance.unmount();
  });

  it("keeps validation errors in the panel", async () => {
    const props = basePanel({
      load: async () => ({ baseUrl: "", chatModel: "", apiKey: "" }),
    });
    const instance = render(<ConfigPanel {...props} />);
    await waitForFrame(instance, (frame) => expect(frame).toContain("Base URL"));

    await press(instance, "\r", LIST_FOOTER);
    await press(instance, "\u0013", "请填写 Base URL。");

    expect(props.save).not.toHaveBeenCalled();
    expect(props.close).not.toHaveBeenCalled();
    instance.unmount();
  });

  it("edits the chat model ID directly without opening a picker", async () => {
    const props = basePanel();
    const instance = render(<ConfigPanel {...props} />);
    await waitForFrame(instance, (frame) => expect(frame).toContain("Base URL"));

    await press(instance, "\r", LIST_FOOTER);
    await press(instance, "\u001b[B", API_KEY_ROW);
    instance.stdin.write("\u001b[B");
    await waitForFocus(instance, "Chat 模型");
    await press(instance, "\r", EDITING_HINT);

    const editor = instance.lastFrame() ?? "";
    expect(editor).not.toContain("Select model");

    instance.stdin.write("\u0015");
    await waitForFrame(instance, (frame) => expect(frame).not.toMatch(/Chat 模型 +qwen/));
    instance.stdin.write("custom-model");
    await waitForFrame(instance, (frame) => expect(frame).toContain("custom-model"));
    await press(instance, "\r", LIST_FOOTER);
    instance.stdin.write("\u0013");

    await vi.waitFor(
      () =>
        expect(props.save).toHaveBeenCalledWith({
          baseUrl: "http://127.0.0.1:1234/v1",
          chatModel: "custom-model",
          answerModel: "qwen-vl",
          apiKey: { kind: "keep" },
        }),
      { timeout: 5_000 },
    );
    instance.unmount();
  }, 40_000);

  it("edits the answer model ID directly and allows clearing it", async () => {
    const props = basePanel();
    const instance = render(<ConfigPanel {...props} />);
    await waitForFrame(instance, (frame) => expect(frame).toContain("Base URL"));

    await press(instance, "\r", LIST_FOOTER);
    await press(instance, "\u001b[B", API_KEY_ROW);
    instance.stdin.write("\u001b[B");
    await waitForFocus(instance, "Chat 模型");
    instance.stdin.write("\u001b[B");
    await waitForFocus(instance, "Answer 模型");
    await press(instance, "\r", EDITING_HINT);
    expect(instance.lastFrame()).toContain("qwen-vl");

    instance.stdin.write("\u0015");
    await waitForFrame(instance, (frame) => expect(frame).not.toMatch(/Answer 模型 +qwen-vl/));
    await press(instance, "\r", LIST_FOOTER);
    instance.stdin.write("\u0013");

    await vi.waitFor(
      () =>
        expect(props.save).toHaveBeenCalledWith({
          baseUrl: "http://127.0.0.1:1234/v1",
          chatModel: "qwen",
          apiKey: { kind: "keep" },
        }),
      { timeout: 5_000 },
    );
    instance.unmount();
  }, 40_000);
});

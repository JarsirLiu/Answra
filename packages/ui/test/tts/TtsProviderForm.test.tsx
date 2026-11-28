import { TTS_PROVIDER_CATALOG, type TtsProviderConfig } from "@answra/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { TtsProviderForm as TtsProviderFormView } from "../../src/components/panels/TtsProviderForm";
import { blankProviderForm, type TtsProviderFormState } from "../../src/tts/providerDraft";

function preset(id: string) {
  const found = TTS_PROVIDER_CATALOG.find((item) => item.id === id);
  if (found === undefined) throw new Error(`目录缺少 ${id}`);
  return found;
}

function provider(overrides: Partial<TtsProviderConfig> = {}): TtsProviderConfig {
  return {
    id: "minimax",
    label: "MiniMax",
    protocol: "minimax-native",
    baseUrl: "https://api.minimax.io",
    model: "speech-2.8-turbo",
    voice: "voice-1",
    hasApiKey: true,
    capabilities: {
      streaming: false,
      formats: ["mp3"],
      maxChars: 1_000,
      supportsSpeed: false,
      supportsEmotion: false,
      voiceCatalog: "remote",
    },
    ...overrides,
  };
}

interface HarnessProps {
  initial: TtsProviderFormState;
  saved?: TtsProviderConfig | null;
  onOpenApiKey?: (url: string) => void;
}

function Harness({ initial, saved = null, onOpenApiKey }: HarnessProps) {
  const [form, setForm] = useState(initial);
  return (
    <TtsProviderFormView
      busy={false}
      form={form}
      notice=""
      onChange={setForm}
      onClear={vi.fn()}
      onOpenApiKey={onOpenApiKey}
      onRevealKey={vi.fn()}
      onSave={vi.fn()}
      provider={saved}
      revealed={false}
    />
  );
}

function value(field: string): string {
  const input = screen.getByLabelText(field);
  if (!(input instanceof HTMLInputElement)) throw new Error(`不是输入控件：${field}`);
  return input.value;
}

describe("TtsProviderForm", () => {
  it("fills every field when a vendor is chosen from the icon dropdown", () => {
    render(<Harness initial={blankProviderForm()} />);

    fireEvent.click(screen.getByRole("button", { name: "供应商" }));
    expect(screen.getByRole("listbox", { name: "供应商" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "MiMo" }));

    expect(screen.queryByLabelText("端点地址")).toBeNull();
    expect(value("模型 ID")).toBe("mimo-v2.5-tts");
    expect(value("音色 ID")).toBe("mimo_default");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.querySelector('[data-vendor-icon="mimo"]')).not.toBeNull();
  });

  it("unlocks the endpoint only after choosing custom", () => {
    render(<Harness initial={blankProviderForm()} />);

    fireEvent.click(screen.getByRole("button", { name: "供应商" }));
    fireEvent.click(screen.getByRole("option", { name: "自定义" }));

    expect(value("端点地址")).toBe("https://api.minimax.io");
  });

  it("switches the wire protocol only after choosing custom", () => {
    render(<Harness initial={blankProviderForm()} />);

    expect(screen.queryByRole("button", { name: "对话式音频" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "供应商" }));
    fireEvent.click(screen.getByRole("option", { name: "自定义" }));
    fireEvent.click(screen.getByRole("button", { name: "对话式音频" }));

    expect(value("端点地址")).toBe(preset("mimo").baseUrl);
    expect(value("模型 ID")).toBe(preset("mimo").model);
  });

  it("links to the vendor API key page only for a known vendor", () => {
    const onOpenApiKey = vi.fn();
    render(<Harness initial={blankProviderForm()} onOpenApiKey={onOpenApiKey} />);

    fireEvent.click(screen.getByRole("button", { name: "获取 API Key" }));
    expect(onOpenApiKey).toHaveBeenCalledWith(preset("minimax").apiKeyUrl);

    fireEvent.click(screen.getByRole("button", { name: "供应商" }));
    fireEvent.click(screen.getByRole("option", { name: "自定义" }));
    expect(screen.queryByRole("button", { name: "获取 API Key" })).toBeNull();
  });

  it("shows the saved key state for the configured provider", () => {
    render(<Harness initial={blankProviderForm()} saved={provider()} />);

    expect(screen.getByText(/API Key（已保存）/)).toBeInTheDocument();
    expect(screen.getByLabelText(/API Key/)).toHaveAttribute("placeholder", "留空沿用已保存的 Key");
    expect(screen.getByRole("button", { name: "清除" })).toBeInTheDocument();
  });

  it("does not add explanatory copy below the form", () => {
    render(<Harness initial={blankProviderForm()} />);

    expect(screen.queryByText(/尚未实机验证/)).toBeNull();
    expect(screen.queryByText(/系统凭据库/)).toBeNull();
  });

  it("routes save, clear and reveal actions to the parent", () => {
    const onSave = vi.fn();
    const onClear = vi.fn();
    const onRevealKey = vi.fn();
    render(
      <TtsProviderFormView
        busy={false}
        form={blankProviderForm()}
        notice=""
        onChange={vi.fn()}
        onClear={onClear}
        onRevealKey={onRevealKey}
        onSave={onSave}
        provider={provider()}
        revealed={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    fireEvent.click(screen.getByRole("button", { name: "清除" }));
    fireEvent.click(screen.getByRole("button", { name: "显示密钥" }));

    expect(onSave).toHaveBeenCalledOnce();
    expect(onClear).toHaveBeenCalledOnce();
    expect(onRevealKey).toHaveBeenCalledOnce();
  });
});

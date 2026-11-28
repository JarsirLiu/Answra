import { type DesktopBridge, TTS_PROVIDER_CATALOG, type TtsSettingsView } from "@answra/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TtsSettingsGroup } from "../../src/components/panels/TtsSettingsGroup";

function settingsView(overrides: Partial<TtsSettingsView> = {}): TtsSettingsView {
  return {
    provider: {
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
    },
    ...overrides,
  };
}

function createBridge(view: TtsSettingsView) {
  const saveTtsSettings = vi.fn(async (patch: unknown) => {
    void patch;
    return view;
  });
  const openExternal = vi.fn(async () => undefined);
  const bridge: DesktopBridge = {
    fitContent: vi.fn(),
    close: vi.fn(),
    getTtsSettings: vi.fn(async () => view),
    openExternal,
    saveTtsSettings,
    revealTtsApiKey: vi.fn(async () => ({ apiKey: "sk-test" })),
  };
  return { bridge, openExternal, saveTtsSettings };
}

describe("TtsSettingsGroup", () => {
  it("shows the provider form directly and has no automatic-reading toggle", async () => {
    const { bridge, saveTtsSettings } = createBridge(settingsView());
    render(<TtsSettingsGroup bridge={bridge} />);

    expect(await screen.findByRole("heading", { name: "语音合成" })).toBeInTheDocument();
    expect(screen.queryByText("切句策略")).toBeNull();
    expect(screen.queryByLabelText("演练自动朗读")).toBeNull();
    expect(screen.getByLabelText("供应商")).toBeInTheDocument();
    expect(saveTtsSettings).not.toHaveBeenCalled();
  });

  it("saves the provider chosen from the vendor dropdown", async () => {
    const { bridge, saveTtsSettings } = createBridge(settingsView({ provider: null }));
    render(<TtsSettingsGroup bridge={bridge} />);

    await screen.findByLabelText("供应商");
    fireEvent.click(screen.getByRole("button", { name: "供应商" }));
    fireEvent.click(screen.getByRole("option", { name: "MiMo" }));
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: "mimo-key" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(saveTtsSettings).toHaveBeenCalledOnce());
    expect(saveTtsSettings.mock.calls[0]?.[0]).toEqual({
      provider: {
        id: "mimo",
        label: "MiMo",
        protocol: "chat-audio",
        baseUrl: "https://api.xiaomimimo.com/v1",
        model: "mimo-v2.5-tts",
        voice: "mimo_default",
        apiKey: "mimo-key",
      },
    });
  });

  it("clears the configured provider", async () => {
    const { bridge, saveTtsSettings } = createBridge(settingsView());
    render(<TtsSettingsGroup bridge={bridge} />);

    fireEvent.click(await screen.findByRole("button", { name: "清除" }));
    await waitFor(() => expect(saveTtsSettings).toHaveBeenCalledWith({ provider: null }));
  });

  it("reveals a saved key only after the explicit reveal action", async () => {
    const { bridge } = createBridge(settingsView());
    render(<TtsSettingsGroup bridge={bridge} />);

    const input = await screen.findByLabelText(/API Key/);
    expect(input).toHaveAttribute("type", "password");

    fireEvent.click(screen.getByRole("button", { name: "显示密钥" }));
    await waitFor(() => expect(bridge.revealTtsApiKey).toHaveBeenCalledWith("minimax"));
    expect(input).toHaveValue("sk-test");
    expect(input).toHaveAttribute("type", "text");
  });

  it("keeps the protocol presets reachable from the custom vendor entry", async () => {
    const { bridge } = createBridge(settingsView({ provider: null }));
    render(<TtsSettingsGroup bridge={bridge} />);

    await screen.findByLabelText("供应商");
    fireEvent.click(screen.getByRole("button", { name: "供应商" }));
    fireEvent.click(screen.getByRole("option", { name: "自定义" }));
    fireEvent.click(screen.getByRole("button", { name: "对话式音频" }));

    expect(screen.getByLabelText(/端点地址/)).toHaveValue("https://api.xiaomimimo.com/v1");
    expect(screen.getByLabelText(/模型 ID/)).toHaveValue("mimo-v2.5-tts");
    expect(screen.getByLabelText(/音色 ID/)).toHaveValue("mimo_default");
  });

  it("opens the vendor API key page from the form link", async () => {
    const { bridge, openExternal } = createBridge(settingsView());
    render(<TtsSettingsGroup bridge={bridge} />);

    fireEvent.click(await screen.findByRole("button", { name: "获取 API Key" }));

    const preset = TTS_PROVIDER_CATALOG.find((item) => item.id === "minimax");
    expect(openExternal).toHaveBeenCalledWith(preset?.apiKeyUrl);
  });

  it("renders nothing when the bridge does not expose tts settings", () => {
    const view = render(<TtsSettingsGroup bridge={{ fitContent: vi.fn(), close: vi.fn() }} />);
    expect(view.container).toBeEmptyDOMElement();
  });
});

import { TTS_PROVIDER_CATALOG, type TtsProviderPreset } from "./catalog";
import type { TtsProtocol } from "./contracts";

/**
 * 新增 provider 时的表单预填值。只填协议确定的默认端点与模型；
 * `voice` 留空表示必须由用户填写（MiniMax 要求音色）。
 */
export interface TtsProtocolPreset {
  readonly protocol: TtsProtocol;
  readonly label: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly voice: string;
}

function protocolPresetOf(preset: TtsProviderPreset): TtsProtocolPreset {
  return {
    protocol: preset.protocol,
    label: preset.label,
    baseUrl: preset.baseUrl,
    model: preset.model,
    voice: preset.voice,
  };
}

/** 每个协议取目录中第一条：协议默认值只有一个来源，不会与厂商目录漂移。 */
function defaultPresetFor(protocol: TtsProtocol): TtsProviderPreset {
  const preset = TTS_PROVIDER_CATALOG.find((candidate) => candidate.protocol === protocol);
  if (preset === undefined) throw new Error(`TTS 厂商目录缺少协议 ${protocol} 的预设`);
  return preset;
}

export const TTS_PROTOCOL_PRESETS: Readonly<Record<TtsProtocol, TtsProtocolPreset>> = {
  "minimax-native": protocolPresetOf(defaultPresetFor("minimax-native")),
  "openai-compatible": protocolPresetOf(defaultPresetFor("openai-compatible")),
  "chat-audio": protocolPresetOf(defaultPresetFor("chat-audio")),
};

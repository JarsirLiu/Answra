import type { TtsProtocol } from "./contracts";

/**
 * 一条厂商预设：只是设置页的供应商选项与表单初值，不是运行时解析源。
 *
 * 保存后配置里是具体值（`tts.provider`），所以目录改名、换默认模型或下线条目
 * 都不会改变已保存 provider 的实际行为。
 */
export interface TtsProviderPreset {
  /** 目录 id，同时作为 provider 的实例 id（keychain account 后缀）。 */
  readonly id: string;
  readonly label: string;
  readonly protocol: TtsProtocol;
  readonly baseUrl: string;
  readonly model: string;
  /** 厂商默认音色；空字符串表示必须由用户填写。 */
  readonly voice: string;
  /** 厂商控制台里创建 API Key 的页面；设置页只给一个跳转入口。 */
  readonly apiKeyUrl: string;
}

/**
 * 厂商目录：同一协议的多家厂商共用 adapter，只有端点、模型与音色不同。
 *
 * 新增一家厂商只改这里一行；新增一种 wire 形状才需要协议 adapter。
 */
export const TTS_PROVIDER_CATALOG: readonly TtsProviderPreset[] = [
  {
    id: "minimax",
    label: "MiniMax",
    protocol: "minimax-native",
    baseUrl: "https://api.minimax.io",
    model: "speech-2.8-turbo",
    // MiniMax 没有服务端默认音色，必须显式传 voice_id；这里给一条官方系统音色，用户可改。
    voice: "Chinese (Mandarin)_News_Anchor",
    apiKeyUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
  },
  {
    id: "mimo",
    label: "MiMo",
    protocol: "chat-audio",
    baseUrl: "https://api.xiaomimimo.com/v1",
    model: "mimo-v2.5-tts",
    voice: "mimo_default",
    apiKeyUrl: "https://platform.xiaomimimo.com/#/console/api-keys",
  },
  {
    id: "openai",
    label: "OpenAI",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "tts-1",
    voice: "alloy",
    apiKeyUrl: "https://platform.openai.com/api-keys",
  },
];

/** 按目录 id 查预设；未命中等同「自定义」，不做猜测或降级。 */
export function findTtsProviderPreset(id: string): TtsProviderPreset | undefined {
  return TTS_PROVIDER_CATALOG.find((preset) => preset.id === id);
}

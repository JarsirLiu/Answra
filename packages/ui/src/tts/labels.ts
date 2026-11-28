import type { TtsProtocol } from "@answra/shared";

/** 协议是内部分层词汇（wire 形状）；厂商名由 `TTS_PROVIDER_CATALOG` 提供。 */
export const TTS_PROTOCOL_LABELS: Readonly<Record<TtsProtocol, string>> = {
  "minimax-native": "MiniMax 原生",
  "openai-compatible": "OpenAI 兼容",
  "chat-audio": "对话式音频",
};

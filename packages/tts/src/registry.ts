/** 协议注册表：唯一构造点，未知协议显式失败，不做静默降级。 */
import type { TtsProtocol } from "@answra/shared/tts";
import type { TtsProviderOptions } from "./contracts";
import { TtsProviderError } from "./errors";
import type { TtsProviderFactory, TtsProviderPort } from "./port";
import { createChatAudioProvider } from "./protocols/chatAudio";
import { createMinimaxNativeProvider } from "./protocols/minimaxNative";
import { createOpenAiCompatibleProvider } from "./protocols/openAiCompatible";

const FACTORIES: Readonly<Record<TtsProtocol, TtsProviderFactory>> = {
  "minimax-native": createMinimaxNativeProvider,
  "openai-compatible": createOpenAiCompatibleProvider,
  "chat-audio": createChatAudioProvider,
};

/** 构造单请求适配器；adapter 测试与自定义编排使用。 */
export function createTtsProviderPort(
  protocol: TtsProtocol,
  options: TtsProviderOptions,
): TtsProviderPort {
  const factory = FACTORIES[protocol] as TtsProviderFactory | undefined;
  if (factory === undefined) {
    throw new TtsProviderError("unsupported-protocol", `不支持的 TTS 协议：${String(protocol)}。`);
  }
  return factory(options);
}

/** 协议适配器契约：一次调用只发一次 wire 请求。 */
import type { TtsProviderCapabilities } from "@answra/shared/tts";
import type { TtsProviderOptions, TtsSynthesisRequest, TtsSynthesisResult } from "./contracts";

export interface TtsProviderPort {
  /** 由 adapter 常量声明，不来自远端探测。 */
  readonly capabilities: TtsProviderCapabilities;
  synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult>;
}

export type TtsProviderFactory = (options: TtsProviderOptions) => TtsProviderPort;

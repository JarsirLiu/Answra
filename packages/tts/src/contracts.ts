/** 合成输入输出：这里是一次 wire 请求的形状，不含任何厂商字段。 */

export interface TtsSynthesisRequest {
  readonly text: string;
  /** 覆盖 provider 默认音色；空表示沿用配置。 */
  readonly voice?: string;
  readonly signal?: AbortSignal;
}

export interface TtsSynthesisResult {
  readonly bytes: Uint8Array;
  /** 由 adapter 按响应判定，不信任请求参数。 */
  readonly mimeType: string;
  /** 拿不到就不填，不估算。 */
  readonly durationMs?: number;
}

export interface TtsProviderOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly voice?: string;
  /** 协议内或厂商私有的非 secret 参数。 */
  readonly options?: Readonly<Record<string, unknown>>;
  /** 测试注入；缺省用 globalThis.fetch。 */
  readonly fetch?: typeof fetch;
  /** 单段合成超时；缺省使用 DEFAULT_TTS_TIMEOUT_MS。 */
  readonly timeoutMs?: number;
}

export const DEFAULT_TTS_TIMEOUT_MS = 30_000;

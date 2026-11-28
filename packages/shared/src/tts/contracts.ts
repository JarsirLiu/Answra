/**
 * TTS 跨进程契约：只放稳定、可序列化的类型与常量。
 *
 * wire 格式（hex、Base64、厂商字段名）留在 `@answra/tts` 的协议适配器里，不进入这里；
 * API Key 永远不进入任何 DTO。
 */

/** 合成协议（wire 格式）。新增协议 = 新增 adapter + 注册表一行 + 这里加一个值。 */
export const TTS_PROTOCOLS = ["minimax-native", "openai-compatible", "chat-audio"] as const;
export type TtsProtocol = (typeof TTS_PROTOCOLS)[number];

/**
 * 合成策略：切句时机与调度方式，与协议正交，属于 `@answra/tts` 的内部实现。
 *
 * - `whole-text`：攒完全文再切、串行合成，手动朗读使用；
 * - `sentence-pipeline`：边收增量边切句、有界并发、按序产出，自动朗读固定使用。
 *
 * 设置页不暴露该选项：自动朗读只有 `sentence-pipeline`，用户不需要做这个选择。
 */
export const TTS_STRATEGIES = ["whole-text", "sentence-pipeline"] as const;
export type TtsStrategyId = (typeof TTS_STRATEGIES)[number];
export const TTS_DEFAULT_STRATEGY: TtsStrategyId = "sentence-pipeline";

/** 契约版本：加字段兼容，改语义必须升版本。 */
export const TTS_CONTRACT_VERSION = 1 as const;

/** provider id 长度上限；唯一化后缀（`-2`）也受它约束。 */
export const TTS_PROVIDER_ID_MAX = 32;

/** provider id 会拼进 keychain account，只允许小写字母、数字与连字符。 */
export const TTS_PROVIDER_ID_PATTERN = new RegExp(`^[a-z0-9-]{1,${TTS_PROVIDER_ID_MAX}}$`);

/**
 * 客户端单次合成的保守字符上限。
 *
 * 这是客户端边界，不是厂商声明：厂商真实上限写进各 adapter 的
 * `capabilities.maxChars`，两者不一致时以 adapter 为准。
 */
export const TTS_DEFAULT_MAX_CHARS = 1_000;

/**
 * 稳定错误码：UI 只判断 `code`，不解析 `message`。
 *
 * - `not-configured`：未选 provider、未填 Key 或未填音色；
 * - `unauthorized`：Key 错误或失效；
 * - `quota-exceeded`：余额或额度不足；
 * - `rate-limited`：并发或频率限制，可退避重试；
 * - `invalid-request`：参数不被接受，通常是配置写错；
 * - `provider-rejected`：HTTP 成功但业务码失败或响应不可用；
 * - `network`：链路失败，可重试；
 * - `timeout`：超过单段合成超时，可重试；
 * - `aborted`：主动取消，属于正常路径；
 * - `empty-audio`：拿到成功响应但音频为空；
 * - `unsupported-protocol`：未知协议，不做静默降级；
 * - `unsupported-strategy`：未知合成策略，不做静默降级。
 */
export const TTS_ERROR_CODES = [
  "not-configured",
  "unauthorized",
  "quota-exceeded",
  "rate-limited",
  "invalid-request",
  "provider-rejected",
  "network",
  "timeout",
  "aborted",
  "empty-audio",
  "unsupported-protocol",
  "unsupported-strategy",
] as const;
export type TtsErrorCode = (typeof TTS_ERROR_CODES)[number];

const RETRYABLE_TTS_ERROR_CODES: ReadonlySet<TtsErrorCode> = new Set([
  "rate-limited",
  "network",
  "timeout",
]);

/** 只表示调用方能否安全重试，不代表 provider 状态未变。 */
export function isRetryableTtsErrorCode(code: TtsErrorCode): boolean {
  return RETRYABLE_TTS_ERROR_CODES.has(code);
}

/**
 * provider 能做什么：由 adapter 常量声明，不来自远端探测。
 *
 * 预设数据里的声明必须与 adapter 自身常量一致；UI 只按这里渲染参数控件。
 */
export interface TtsProviderCapabilities {
  readonly streaming: boolean;
  readonly formats: readonly string[];
  /** 单次请求字符上限；编排层据此切句。 */
  readonly maxChars: number;
  readonly supportsSpeed: boolean;
  readonly supportsEmotion: boolean;
  readonly voiceCatalog: "static" | "remote" | "none";
}

/** 渲染层可见的 provider 摘要（真 Key 只以 `hasApiKey` 表示）。 */
export interface TtsProviderConfig {
  readonly id: string;
  readonly label: string;
  readonly protocol: TtsProtocol;
  readonly baseUrl: string;
  readonly model: string;
  readonly voice: string;
  readonly hasApiKey: boolean;
  readonly capabilities: TtsProviderCapabilities;
}

/** 保存 provider 的入参；`apiKey` 留空表示沿用已保存的 Key。 */
export interface TtsProviderDraft {
  readonly id: string;
  readonly label: string;
  readonly protocol: TtsProtocol;
  readonly baseUrl: string;
  readonly model: string;
  readonly voice: string;
  readonly apiKey?: string;
}

/**
 * 设置页的 TTS 视图：只维护一个 provider。
 *
 * 没有独立开关：只要保存了 provider，演练模式就自动朗读；未配置即保持文字模式。
 */
export interface TtsSettingsView {
  /** 当前唯一 provider；`null` 表示尚未配置。 */
  readonly provider: TtsProviderConfig | null;
}

/**
 * 保存设置：`provider` 整体替换当前 provider，`null` 表示清除。
 *
 * 不传则保持原值；`apiKey` 留空表示沿用已保存的 Key。
 */
export interface TtsSettingsPatch {
  readonly provider?: TtsProviderDraft | null;
}

/**
 * agent 的朗读意图：仅演练模式发出，形状是「可朗读文本增量」。
 *
 * - `sequence` 在同一 `messageId` 内从 0 递增；
 * - 首版可以只在文本结算时发一条 `{ delta: 全文, final: true }`，之后改逐帧不需要改协议；
 * - `conversationId` 由 agent 在落账处提供，desktop 用它做取消分代与音频帧归属。
 */
export interface TtsSpeakIntent {
  readonly conversationId: string;
  readonly messageId: string;
  readonly sequence: number;
  readonly delta: string;
  readonly final: boolean;
}

/** 渲染层手动朗读：不绑定会话生命周期，取消时按全局停止处理。 */
export interface TtsSpeakRequest {
  readonly messageId: string;
  readonly text: string;
}

export type TtsSource = "auto" | "manual";

/**
 * 一条消息的音频帧。
 *
 * 首版整段合成通常只有 `sequence: 0`；超长文本由编排层按句切分后产生多帧，
 * 播放端按 `messageId` 归组、按 `sequence` 排序。
 */
export interface TtsAudioFrame {
  readonly messageId: string;
  /** 自动朗读归属会话；手动朗读为 null（不参与会话级取消）。 */
  readonly conversationId: string | null;
  readonly source: TtsSource;
  readonly sequence: number;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface TtsFailure {
  readonly code: TtsErrorCode;
  /** 面向用户的短说明；任何一层都不得用它做判断。 */
  readonly message: string;
  readonly retryable: boolean;
}

/** 合成失败的推送载荷：渲染层据此提示，不弹全局错误。 */
export interface TtsFailureEvent {
  readonly messageId: string;
  readonly conversationId: string | null;
  readonly failure: TtsFailure;
}

/** 停止播放；`conversationId: null` 表示停止全部（切换模式、停止会话）。 */
export interface TtsStopPayload {
  readonly conversationId: string | null;
}

export function isTtsProtocol(value: unknown): value is TtsProtocol {
  return typeof value === "string" && (TTS_PROTOCOLS as readonly string[]).includes(value);
}

export function isTtsStrategyId(value: unknown): value is TtsStrategyId {
  return typeof value === "string" && (TTS_STRATEGIES as readonly string[]).includes(value);
}

export function isTtsProviderId(value: string): boolean {
  return TTS_PROVIDER_ID_PATTERN.test(value);
}

export function isTtsErrorCode(value: unknown): value is TtsErrorCode {
  return typeof value === "string" && (TTS_ERROR_CODES as readonly string[]).includes(value);
}

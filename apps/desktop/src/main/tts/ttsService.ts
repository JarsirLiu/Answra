/**
 * 桌面 TTS 合成服务：把 agent 文本增量与手动朗读交给 `@answra/tts`，音频帧直接推给渲染层。
 *
 * 不决定「该不该读」（agent 只对演练正文发意图）、不切句、不排序、不写 transcript；
 * Key 只在 main 内解密后交给合成库，永不进入渲染层。
 */
import type { ClientTtsConfig, ClientTtsProviderConfig } from "@answra/config";
import {
  isRetryableTtsErrorCode,
  type TtsAudioFrame,
  type TtsErrorCode,
  type TtsFailure,
  type TtsFailureEvent,
  type TtsSource,
  type TtsSpeakIntent,
  type TtsSpeakRequest,
  type TtsStopPayload,
  type TtsStrategyId,
} from "@answra/shared";
import { createTtsSpeaker, isTtsProviderError } from "@answra/tts";
import { createTtsTextChannel } from "./textChannel";

/** 合成只需要读设置与解密 Key；不依赖设置页的保存/视图能力。 */
export interface TtsSettingsPort {
  read(): ClientTtsConfig;
  readApiKey(providerId: string): Promise<string | null>;
}

/** 合成失败时只把稳定码转成受控文案；provider 原始响应体不进入渲染层。 */
const FAILURE_MESSAGES: Readonly<Record<TtsErrorCode, string>> = {
  "not-configured": "尚未配置语音合成，请到设置 → 语音合成填写 provider 与 API Key。",
  unauthorized: "语音合成的 API Key 无效或已失效。",
  "quota-exceeded": "语音合成额度不足，请检查 provider 账户。",
  "rate-limited": "语音合成请求过于频繁，请稍后再试。",
  "invalid-request": "语音合成参数被拒绝，请检查 provider 配置。",
  "provider-rejected": "语音合成服务拒绝了请求。",
  network: "无法连接语音合成服务。",
  timeout: "语音合成超时。",
  aborted: "语音合成已取消。",
  "empty-audio": "语音合成返回了空音频。",
  "unsupported-protocol": "不支持的语音合成协议。",
  "unsupported-strategy": "不支持的语音合成策略。",
};

export interface TtsEmitter {
  audio(frame: TtsAudioFrame): void;
  stopped(payload: TtsStopPayload): void;
  failed(event: TtsFailureEvent): void;
}

export interface TtsServiceOptions {
  readonly settings: TtsSettingsPort;
  readonly emit: TtsEmitter;
  readonly log?: (message: string, error?: unknown) => void;
}

interface ResolvedTarget {
  readonly provider: ClientTtsProviderConfig;
  readonly apiKey: string;
}

interface AutoUtterance {
  readonly conversationId: string;
  readonly controller: AbortController;
  readonly channel: ReturnType<typeof createTtsTextChannel>;
}

export class TtsService {
  private readonly auto = new Map<string, AutoUtterance>();
  private manual?: AbortController;
  /** 意图按到达顺序串行处理：同一 messageId 的多帧不能各建一条合成流。 */
  private intentChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: TtsServiceOptions) {}

  /** agent 的演练朗读意图；失败只推一条 visible 事件，绝不影响文字回复。 */
  handleIntent(intent: TtsSpeakIntent): Promise<void> {
    this.intentChain = this.intentChain
      .then(() => this.processIntent(intent))
      .catch((error: unknown) => {
        this.options.log?.("[tts] 朗读意图处理失败", error);
      });
    return this.intentChain;
  }

  /** 手动朗读：整段文本走 `whole-text`，一次请求、没有段间间隙。 */
  async speak(request: TtsSpeakRequest): Promise<{ accepted: boolean }> {
    const target = await this.resolveTarget();
    if ("failure" in target) {
      this.options.emit.failed({
        messageId: request.messageId,
        conversationId: null,
        failure: target.failure,
      });
      return { accepted: false };
    }

    // 用户主动朗读等于重播：先停掉上一次自动或手动播放，避免两层声音叠在一起。
    this.stop({ conversationId: null });
    const controller = new AbortController();
    this.manual = controller;
    void this.run({
      messageId: request.messageId,
      conversationId: null,
      source: "manual",
      text: singleChunk(request.text),
      strategy: "whole-text",
      signal: controller.signal,
      target,
    }).finally(() => {
      if (this.manual === controller) this.manual = undefined;
    });
    return { accepted: true };
  }

  /** `conversationId: null` 停止全部；否则只停该会话的自动朗读，并广播给渲染层清队列。 */
  stop(payload: TtsStopPayload): void {
    for (const [messageId, utterance] of this.auto) {
      if (payload.conversationId !== null && utterance.conversationId !== payload.conversationId) {
        continue;
      }
      utterance.controller.abort();
      utterance.channel.finish();
      this.auto.delete(messageId);
    }
    if (payload.conversationId === null && this.manual !== undefined) {
      this.manual.abort();
      this.manual = undefined;
    }
    this.options.emit.stopped(payload);
  }

  dispose(): void {
    for (const utterance of this.auto.values()) {
      utterance.controller.abort();
      utterance.channel.finish();
    }
    this.auto.clear();
    this.manual?.abort();
    this.manual = undefined;
  }

  private async processIntent(intent: TtsSpeakIntent): Promise<void> {
    const settings = this.options.settings.read();
    // 未配置 provider 时保持文字模式：静默跳过，不把「没配语音」当错误刷到聊天里。
    if (settings.provider === null) return;

    const existing = this.auto.get(intent.messageId);
    if (existing !== undefined && existing.conversationId !== intent.conversationId) {
      existing.controller.abort();
      existing.channel.finish();
      this.auto.delete(intent.messageId);
    }

    let utterance = this.auto.get(intent.messageId);
    if (utterance === undefined) {
      const target = await this.resolveTargetFrom(settings);
      if ("failure" in target) {
        // 多帧只在第一帧提示一次，避免同一条消息刷出一串失败。
        if (intent.sequence === 0) {
          this.options.emit.failed({
            messageId: intent.messageId,
            conversationId: intent.conversationId,
            failure: target.failure,
          });
        }
        return;
      }
      utterance = this.startAuto(intent, target);
    }
    utterance.channel.push(intent.delta);
    if (intent.final) utterance.channel.finish();
  }

  private startAuto(intent: TtsSpeakIntent, target: ResolvedTarget): AutoUtterance {
    const controller = new AbortController();
    const channel = createTtsTextChannel();
    const utterance: AutoUtterance = {
      conversationId: intent.conversationId,
      controller,
      channel,
    };
    this.auto.set(intent.messageId, utterance);
    void this.run({
      messageId: intent.messageId,
      conversationId: intent.conversationId,
      source: "auto",
      text: channel.text,
      strategy: "sentence-pipeline",
      signal: controller.signal,
      target,
    }).finally(() => {
      if (this.auto.get(intent.messageId) === utterance) this.auto.delete(intent.messageId);
    });
    return utterance;
  }

  private async run(options: {
    messageId: string;
    conversationId: string | null;
    source: TtsSource;
    text: AsyncIterable<string>;
    strategy: TtsStrategyId;
    signal: AbortSignal;
    target: ResolvedTarget;
  }): Promise<void> {
    try {
      const speaker = createTtsSpeaker(
        options.target.provider.protocol,
        {
          baseUrl: options.target.provider.baseUrl,
          model: options.target.provider.model,
          apiKey: options.target.apiKey,
          voice: options.target.provider.voice,
        },
        { strategy: options.strategy },
      );
      for await (const segment of speaker.speak(
        { messageId: options.messageId, text: options.text },
        { signal: options.signal },
      )) {
        if (options.signal.aborted) return;
        this.options.emit.audio({
          messageId: options.messageId,
          conversationId: options.conversationId,
          source: options.source,
          sequence: segment.sequence,
          mimeType: segment.mimeType,
          bytes: segment.bytes,
        });
      }
    } catch (error) {
      // 主动取消是正常路径：渲染层已经收到 Stop，不再弹错误。
      if (options.signal.aborted) return;
      if (isTtsProviderError(error) && error.code === "aborted") return;
      this.options.log?.("[tts] 合成失败", error);
      this.options.emit.failed({
        messageId: options.messageId,
        conversationId: options.conversationId,
        failure: toFailure(error),
      });
    }
  }

  private resolveTarget(): Promise<ResolvedTarget | { failure: TtsFailure }> {
    return this.resolveTargetFrom(this.options.settings.read());
  }

  private async resolveTargetFrom(
    settings: ClientTtsConfig,
  ): Promise<ResolvedTarget | { failure: TtsFailure }> {
    const provider = settings.provider;
    if (provider === null) return { failure: failureOf("not-configured") };

    let apiKey: string | null;
    try {
      apiKey = await this.options.settings.readApiKey(provider.id);
    } catch (error) {
      this.options.log?.("[tts] 系统凭据库不可用，无法读取 TTS Key", error);
      return { failure: failureOf("unauthorized") };
    }
    if (apiKey === null || apiKey.trim() === "") return { failure: failureOf("not-configured") };
    return { provider, apiKey };
  }
}

function toFailure(error: unknown): TtsFailure {
  const code = isTtsProviderError(error) ? error.code : "provider-rejected";
  return failureOf(code);
}

function failureOf(code: TtsErrorCode): TtsFailure {
  return {
    code,
    message: FAILURE_MESSAGES[code],
    retryable: isRetryableTtsErrorCode(code),
  };
}

async function* singleChunk(text: string): AsyncGenerator<string> {
  yield text;
}

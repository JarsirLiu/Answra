import type { AudioSegment, SessionId, TranscriptEvent } from "../contracts";
import type { LocalParaformerAdapter } from "./local/adapter";

/**
 * 面试转录泵：把 VAD 产出的分段消费成 transcript-event。一次会话一条
 * 串行解码链（本地离线解码为同步 native 调用，串行保证大段不饿死小段）；
 * 会话 stop/fail 后取消信号先行、迟到结果丢弃，绝不向失效会话投递事件。
 * provider 装配失败由组合层 fail-closed；解码错误经 adapter 归一化后
 * 仍以 error 事件投出（重试语义由消费端决定）。
 */

export interface TranscriptionPumpOptions {
  emit(event: TranscriptEvent): void;
}

interface SessionRuntime {
  provider: LocalParaformerAdapter;
  abort: AbortController;
  chain: Promise<void>;
}

export class TranscriptionPump {
  private readonly sessions = new Map<SessionId, SessionRuntime>();

  constructor(private readonly options: TranscriptionPumpOptions) {}

  start(sessionId: SessionId, provider: LocalParaformerAdapter): void {
    this.sessions.set(sessionId, {
      provider,
      abort: new AbortController(),
      chain: Promise.resolve(),
    });
  }

  handleSegment(segment: AudioSegment): void {
    const runtime = this.sessions.get(segment.sessionId);
    if (!runtime) return;
    runtime.chain = runtime.chain.then(() => this.transcribeOne(runtime, segment));
  }

  stop(sessionId: SessionId): void {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) return;
    this.sessions.delete(sessionId);
    runtime.abort.abort();
  }

  fail(sessionId: SessionId): void {
    this.stop(sessionId);
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }

  private async transcribeOne(runtime: SessionRuntime, segment: AudioSegment): Promise<void> {
    try {
      const events = await runtime.provider.transcribe(segment, runtime.abort.signal);
      if (this.sessions.get(segment.sessionId) !== runtime) return;
      for (const event of events) this.options.emit(event);
    } catch (error) {
      // adapter 契约保证解码错误归一化为 error 事件；此守卫只为不炸链。
      console.warn("[interview-transcription] pump decode failed", error);
    }
  }
}

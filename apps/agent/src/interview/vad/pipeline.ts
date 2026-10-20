import {
  type AudioSegment,
  type AudioSource,
  type PcmFrame,
  type SessionId,
  sessionId as toSessionId,
} from "../contracts";
import {
  TEN_VAD_ONSET_THRESHOLD,
  VAD_STAGING_SEGMENT_LIMIT,
  VAD_WARMUP_PENDING_FRAMES,
} from "./config";
import { VadSegmenter } from "./segmenter";
import { SpeechActivityDetector } from "./speechDetector";
import type { TenVadEngine, TenVadHop, TenVadSource } from "./tenVadEngine";

/**
 * 面试 VAD 的会话装配层：一个会话一条流水线，帧按源路由到 检测器 → 分段器。
 * 检测结果是「先入内存暂存（有界）」的阶段 3 形态；阶段 4 的转录消费者接管后
 * 把暂存升级为直接投递。任何推理/数据错误都转换为会话级 runtime-failed，
 * 绝不降级成「假装没有语音」继续处理。
 */

export interface InterviewVadPipelineOptions {
  vad: TenVadSource;
  failSession(sessionId: SessionId, code: "runtime-failed"): void;
}

interface SourceRuntime {
  source: AudioSource;
  hop: TenVadHop;
  detector: SpeechActivityDetector;
  segmenter: VadSegmenter;
}

interface SessionRuntime {
  sessionId: SessionId;
  engine?: TenVadEngine;
  sources: Map<AudioSource, SourceRuntime>;
  pendingFrames: PcmFrame[];
  staged: AudioSegment[];
}

export class InterviewVadPipeline {
  private readonly sessions = new Map<SessionId, SessionRuntime>();
  private engine?: Promise<TenVadEngine>;

  constructor(private readonly options: InterviewVadPipelineOptions) {}

  async start(sessionId: SessionId): Promise<void> {
    const runtime: SessionRuntime = {
      sessionId,
      sources: new Map(),
      pendingFrames: [],
      staged: [],
    };
    this.sessions.set(sessionId, runtime);
    try {
      runtime.engine = await this.loadEngine();
    } catch (error) {
      this.sessions.delete(sessionId);
      throw error;
    }
    if (this.sessions.get(sessionId) !== runtime) return;
    for (const frame of runtime.pendingFrames.splice(0)) this.deliver(runtime, frame);
  }

  handleFrame(frame: PcmFrame): void {
    const runtime = this.sessions.get(frame.sessionId);
    if (!runtime) return;
    if (!runtime.engine) {
      runtime.pendingFrames.push(frame);
      if (runtime.pendingFrames.length > VAD_WARMUP_PENDING_FRAMES)
        this.failSession(runtime, new Error("VAD 模块加载期间积压帧超出缓冲上限"));
      return;
    }
    this.deliver(runtime, frame);
  }

  stop(sessionId: SessionId): void {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) return;
    this.sessions.delete(sessionId);
    const segments: AudioSegment[] = [];
    for (const source of runtime.sources.values()) {
      segments.push(...source.segmenter.flush(sessionId, source.source));
    }
    this.stage(runtime, segments);
    this.teardown(runtime);
  }

  fail(sessionId: SessionId): void {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) return;
    this.sessions.delete(sessionId);
    this.teardown(runtime);
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.fail(id);
  }

  /** 阶段 3 暂存视图（测试与后续消费者观察点）；会话不存在时为空。 */
  stagedSegments(sessionId: string): readonly AudioSegment[] {
    return this.sessions.get(toSessionId(sessionId))?.staged ?? [];
  }

  private async loadEngine(): Promise<TenVadEngine> {
    this.engine ??= this.options.vad.load();
    return this.engine;
  }

  private deliver(runtime: SessionRuntime, frame: PcmFrame): void {
    try {
      const engine = runtime.engine;
      if (!engine) throw new Error("VAD 引擎尚未就绪");
      const sourceRuntime = this.sourceFor(runtime, frame.source, engine);
      const activity = sourceRuntime.detector.process(frame);
      this.stage(runtime, sourceRuntime.segmenter.pushFrame(frame, activity));
    } catch (error) {
      this.failSession(runtime, error);
    }
  }

  private sourceFor(
    runtime: SessionRuntime,
    source: AudioSource,
    engine: TenVadEngine,
  ): SourceRuntime {
    const existing = runtime.sources.get(source);
    if (existing) return existing;
    const hop = engine.createHop(TEN_VAD_ONSET_THRESHOLD);
    const created: SourceRuntime = {
      source,
      hop,
      detector: new SpeechActivityDetector(hop, runtime.sessionId, source),
      segmenter: new VadSegmenter(runtime.sessionId, source),
    };
    runtime.sources.set(source, created);
    return created;
  }

  /** 有界暂存：溢出丢弃最旧段（阶段 4 接管前不产生任何外部副作用）。 */
  private stage(runtime: SessionRuntime, segments: readonly AudioSegment[]): void {
    if (segments.length === 0) return;
    runtime.staged.push(...segments);
    const overflow = runtime.staged.length - VAD_STAGING_SEGMENT_LIMIT;
    if (overflow > 0) runtime.staged.splice(0, overflow);
  }

  private failSession(runtime: SessionRuntime, error: unknown): void {
    console.warn("[interview-vad] session failed", error);
    this.sessions.delete(runtime.sessionId);
    this.teardown(runtime);
    this.options.failSession(runtime.sessionId, "runtime-failed");
  }

  private teardown(runtime: SessionRuntime): void {
    const engine = this.engine;
    if (!engine) return;
    void engine.then((loaded) => {
      for (const source of runtime.sources.values()) loaded.destroyHop(source.hop);
    });
    for (const source of runtime.sources.keys()) runtime.sources.delete(source);
  }
}

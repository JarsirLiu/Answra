/** Interview media runtime：编排音频、VAD、ASR、turn 结算与 InterviewApplication。 */
import type { InterviewApplication } from "./application";
import { InterviewAudioIngress } from "./audio/ingress";
import {
  conversationId as asConversationId,
  sessionId as asSessionId,
  type InterviewDomainEvent,
} from "./contracts";
import { LocalParaformerAdapter } from "./transcription/local/adapter";
import type { RecognizerSource } from "./transcription/local/recognizerPort";
import { TranscriptionPump } from "./transcription/pump";
import { InterviewTurnAssembler } from "./turns/assembler";
import {
  CandidateTurnSettler,
  type CandidateTurnSettlerOptions,
  DEFAULT_CANDIDATE_TURN_SETTLE_MS,
  MIN_CANDIDATE_TURN_CHARS,
} from "./turns/settler";
import { InterviewVadPipeline } from "./vad/pipeline";
import type { TenVadSource } from "./vad/tenVadEngine";

export interface InterviewRuntimeOptions {
  /**
   * 按会话解析所属领域的 application：演练、辅助与资料整理共用同一条
   * VAD/ASR/turn 管线，结算与停止必须落回发起采集的那个领域。
   */
  resolveApplication: (conversationId: string) => InterviewApplication;
  vad: TenVadSource;
  recognizer: RecognizerSource;
  turnSettler?: CandidateTurnSettlerOptions;
  emit: (event: InterviewDomainEvent) => void;
}

export class InterviewRuntime {
  private readonly resolveApplication: (conversationId: string) => InterviewApplication;
  private readonly recognizer: RecognizerSource;
  private readonly emit: (event: InterviewDomainEvent) => void;
  private readonly audio: InterviewAudioIngress;
  private readonly transcription: TranscriptionPump;
  private readonly vad: InterviewVadPipeline;
  private readonly assembler = new InterviewTurnAssembler();
  private readonly settler: CandidateTurnSettler;
  private readonly conversations = new Map<string, string>();
  /** 已经开始过的会话；dispose 时逐个收口，避免只停一个领域。 */
  private readonly startedApplications = new Set<string>();
  private recognizerAssembly?: Promise<LocalParaformerAdapter>;
  private disposed = false;

  constructor(options: InterviewRuntimeOptions) {
    this.resolveApplication = options.resolveApplication;
    this.recognizer = options.recognizer;
    this.emit = options.emit;
    this.settler = new CandidateTurnSettler(
      options.turnSettler ?? {
        settleMs: DEFAULT_CANDIDATE_TURN_SETTLE_MS,
        minTurnChars: MIN_CANDIDATE_TURN_CHARS,
      },
      {
        onSettled: (turns, text) => {
          const first = turns[0];
          if (first) {
            void this.resolveApplication(first.conversationId).turnSettled(
              first.conversationId,
              turns,
              text,
            );
          }
        },
      },
    );
    this.audio = new InterviewAudioIngress({
      emit: this.emit,
      onFrame: (frame) => this.vad.handleFrame(frame),
    });
    this.transcription = new TranscriptionPump({
      emit: (event) => {
        this.emit({ type: "transcript-event", event });
        const turn = this.assembler.accept(event);
        if (!turn) return;
        if (turn.status === "incomplete") {
          this.emit({ type: "turn-incomplete", turn });
          return;
        }
        const text = turn.chunks
          .map((chunk) => chunk.text)
          .join("")
          .trim();
        if (text) this.settler.receive(turn);
      },
    });
    this.vad = new InterviewVadPipeline({
      vad: options.vad,
      failSession: (id, code) => {
        this.assembler.reset(id);
        this.settler.discard(id);
        this.stopApplication(this.conversations.get(id));
        this.conversations.delete(id);
        this.transcription.fail(id);
        this.audio.fail(id, code);
      },
      onSegment: (segment) => {
        const conversationId = this.conversations.get(segment.sessionId);
        if (!conversationId) return;
        this.assembler.registerSegment(segment, asConversationId(conversationId));
        this.transcription.handleSegment(segment);
      },
    });
  }

  async start(sessionId: string, conversationId: string): Promise<void> {
    const application = this.resolveApplication(conversationId);
    await application.createConversation(conversationId);
    application.start();
    this.startedApplications.add(conversationId);
    this.conversations.set(sessionId, conversationId);
    this.audio.start(asSessionId(sessionId), asConversationId(conversationId));
    try {
      await this.vad.start(asSessionId(sessionId));
      this.transcription.start(asSessionId(sessionId), await this.loadRecognizer());
    } catch (error) {
      this.vad.fail(asSessionId(sessionId));
      this.audio.fail(asSessionId(sessionId), "runtime-failed");
      this.stopApplication(conversationId);
      this.conversations.delete(sessionId);
      throw error;
    }
  }

  captureReady(sessionId: string): boolean {
    return this.audio.captureReady(asSessionId(sessionId));
  }

  captureFailed(sessionId: string): void {
    const id = asSessionId(sessionId);
    this.assembler.reset(id);
    this.settler.discard(id);
    this.stopApplication(this.conversations.get(sessionId));
    this.conversations.delete(sessionId);
    this.vad.fail(id);
    this.transcription.fail(id);
    this.audio.fail(id, "capture-failed");
  }

  acceptFrame(frame: unknown): ReturnType<InterviewAudioIngress["acceptFrame"]> {
    return this.audio.acceptFrame(frame);
  }

  stop(sessionId: string): void {
    const id = asSessionId(sessionId);
    const conversationId = this.conversations.get(sessionId);
    this.settler.flush(id);
    this.stopApplication(conversationId);
    this.assembler.reset(id);
    this.conversations.delete(sessionId);
    this.vad.stop(id);
    this.transcription.stop(id);
    this.audio.stop(id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.settler.discardAll();
    for (const conversationId of this.startedApplications) {
      void this.resolveApplication(conversationId).stop();
    }
    this.startedApplications.clear();
    this.vad.dispose();
    this.transcription.dispose();
  }

  /** 结束采集时只收口发起该会话的 application，不误停其他领域。 */
  private stopApplication(conversationId: string | undefined): void {
    if (conversationId === undefined) return;
    this.startedApplications.delete(conversationId);
    void this.resolveApplication(conversationId).stop();
  }

  private loadRecognizer(): Promise<LocalParaformerAdapter> {
    this.recognizerAssembly ??= this.recognizer
      .load()
      .then((assembly) => new LocalParaformerAdapter(assembly));
    return this.recognizerAssembly;
  }
}

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
  application: InterviewApplication;
  vad: TenVadSource;
  recognizer: RecognizerSource;
  turnSettler?: CandidateTurnSettlerOptions;
  emit: (event: InterviewDomainEvent) => void;
}

export class InterviewRuntime {
  private readonly application: InterviewApplication;
  private readonly recognizer: RecognizerSource;
  private readonly emit: (event: InterviewDomainEvent) => void;
  private readonly audio: InterviewAudioIngress;
  private readonly transcription: TranscriptionPump;
  private readonly vad: InterviewVadPipeline;
  private readonly assembler = new InterviewTurnAssembler();
  private readonly settler: CandidateTurnSettler;
  private readonly conversations = new Map<string, string>();
  private recognizerAssembly?: Promise<LocalParaformerAdapter>;
  private disposed = false;

  constructor(options: InterviewRuntimeOptions) {
    this.application = options.application;
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
          if (first) void this.application.turnSettled(first.conversationId, turns, text);
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
        this.conversations.delete(id);
        this.transcription.fail(id);
        this.audio.fail(id, code);
        void this.application.stop();
      },
      onSpeechActivity: (event) => this.application.speechStarted(event.source),
      onSegment: (segment) => {
        const conversationId = this.conversations.get(segment.sessionId);
        if (!conversationId) return;
        this.assembler.registerSegment(segment, asConversationId(conversationId));
        this.transcription.handleSegment(segment);
      },
    });
  }

  async start(sessionId: string, conversationId: string): Promise<void> {
    await this.application.createConversation(conversationId);
    this.application.start();
    this.conversations.set(sessionId, conversationId);
    this.audio.start(asSessionId(sessionId), asConversationId(conversationId));
    try {
      await this.vad.start(asSessionId(sessionId));
      this.transcription.start(asSessionId(sessionId), await this.loadRecognizer());
    } catch (error) {
      this.vad.fail(asSessionId(sessionId));
      this.audio.fail(asSessionId(sessionId), "runtime-failed");
      this.conversations.delete(sessionId);
      await this.application.stop();
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
    this.conversations.delete(sessionId);
    this.vad.fail(id);
    this.transcription.fail(id);
    this.audio.fail(id, "capture-failed");
    void this.application.stop();
  }

  acceptFrame(frame: unknown): ReturnType<InterviewAudioIngress["acceptFrame"]> {
    return this.audio.acceptFrame(frame);
  }

  stop(sessionId: string): void {
    const id = asSessionId(sessionId);
    this.settler.flush(id);
    void this.application.stop();
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
    void this.application.stop();
    this.vad.dispose();
    this.transcription.dispose();
  }

  private loadRecognizer(): Promise<LocalParaformerAdapter> {
    this.recognizerAssembly ??= this.recognizer
      .load()
      .then((assembly) => new LocalParaformerAdapter(assembly));
    return this.recognizerAssembly;
  }
}

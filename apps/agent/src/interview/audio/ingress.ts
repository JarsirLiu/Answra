import {
  type ConversationId,
  type InterviewDomainEvent,
  type InterviewSession,
  type PcmFrame,
  type SessionId,
  transitionInterviewSession,
} from "../contracts";
import { type PcmFrameValidation, PcmFrameValidator } from "./pcmFrameValidator";

export interface InterviewAudioIngressPorts {
  emit(event: InterviewDomainEvent): void;
  onFrame(frame: PcmFrame): void;
}

/** Owns one capture run and hands validated PCM frames to downstream audio modules. */
export class InterviewAudioIngress {
  private session?: InterviewSession;
  private validator?: PcmFrameValidator;

  constructor(private readonly ports: InterviewAudioIngressPorts) {}

  start(sessionId: SessionId, conversationId: ConversationId): InterviewSession {
    if (this.session && this.session.state !== "stopped" && this.session.state !== "failed") {
      throw new Error("an interview audio session is already active");
    }

    this.session = { sessionId, conversationId, state: "starting" };
    this.validator = new PcmFrameValidator(sessionId);
    this.ports.emit({
      type: "session-state-changed",
      sessionId,
      conversationId,
      state: "starting",
    });
    return this.session;
  }

  captureReady(sessionId: SessionId): boolean {
    const transition = this.transition({ type: "capture-ready", sessionId });
    if (!transition) return false;
    this.ports.emit({
      type: "session-started",
      sessionId,
      conversationId: transition.conversationId,
    });
    this.emitState(transition);
    return true;
  }

  acceptFrame(input: unknown): PcmFrameValidation {
    if (!this.session || !this.validator) {
      return { accepted: false, code: "not-listening" };
    }

    const result = this.validator.accept(input, this.session);
    if (!result.accepted) return result;

    if (result.gap) {
      this.ports.emit({
        type: "audio-gap",
        sessionId: result.frame.sessionId,
        ...result.gap,
      });
    }
    this.ports.onFrame(result.frame);
    return result;
  }

  stop(sessionId: SessionId): boolean {
    const stopping = this.transition({ type: "stop-requested", sessionId });
    if (!stopping) return false;
    this.emitState(stopping);

    const stopped = this.transition({ type: "cleanup-completed", sessionId });
    if (!stopped) return false;
    this.emitState(stopped);
    this.ports.emit({
      type: "session-stopped",
      sessionId,
      conversationId: stopped.conversationId,
    });
    return true;
  }

  fail(sessionId: SessionId, code: "capture-failed" | "runtime-failed"): boolean {
    const failed = this.transition({ type: "failed", sessionId, code });
    if (!failed) return false;
    this.ports.emit({
      type: "session-failed",
      sessionId,
      conversationId: failed.conversationId,
      code,
    });
    this.emitState(failed);
    return true;
  }

  private transition(
    event: Parameters<typeof transitionInterviewSession>[1],
  ): InterviewSession | undefined {
    if (!this.session) return undefined;
    const result = transitionInterviewSession(this.session, event);
    if (!result.accepted) return undefined;
    this.session = result.session;
    return result.session;
  }

  private emitState(session: InterviewSession): void {
    this.ports.emit({
      type: "session-state-changed",
      sessionId: session.sessionId,
      conversationId: session.conversationId,
      state: session.state,
    });
  }
}

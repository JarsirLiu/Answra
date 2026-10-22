import { randomUUID } from "node:crypto";
import { INTERVIEW_AUDIO_CREDIT_WINDOW, type InterviewPcmFrame } from "@answra/shared";
import type { AgentService } from "../conversation/agentService";

interface ActiveCapture {
  sessionId: string;
  conversationId: string;
  state: "starting" | "listening";
}

/** Main-process owner for the single active microphone capture run. */
export class InterviewCaptureService {
  private active?: ActiveCapture;

  constructor(private readonly agent: AgentService) {}

  async start(conversationId: string): Promise<{ sessionId: string }> {
    if (process.platform !== "win32") throw new Error("面试语音采集当前仅支持 Windows");
    if (this.active) throw new Error("面试语音采集已经启动");

    const active: ActiveCapture = {
      sessionId: randomUUID(),
      conversationId,
      state: "starting",
    };
    this.active = active;
    try {
      await this.agent.startInterview(active.sessionId, active.conversationId);
      return { sessionId: active.sessionId };
    } catch (error) {
      if (this.active === active) this.active = undefined;
      throw error;
    }
  }

  async captureReady(sessionId: string): Promise<boolean> {
    const active = this.getActive(sessionId);
    if (active?.state !== "starting") return false;
    await this.agent.markInterviewCaptureReady(sessionId);
    if (this.active !== active) return false;
    active.state = "listening";
    return true;
  }

  async fail(sessionId: string): Promise<boolean> {
    const active = this.getActive(sessionId);
    if (!active) return false;
    this.active = undefined;
    await this.agent.failInterviewCapture(sessionId);
    return true;
  }

  async stop(sessionId: string): Promise<boolean> {
    const active = this.getActive(sessionId);
    if (!active) return false;
    this.active = undefined;
    await this.agent.stopInterview(sessionId);
    return true;
  }

  async stopActive(): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    await this.agent.stopInterview(active.sessionId);
  }

  allowsMicrophonePermission(): boolean {
    return this.active?.state === "starting";
  }

  /** Receives a DTO already validated by the IPC boundary; session ownership is checked here. */
  acceptFrame(frame: InterviewPcmFrame): boolean {
    const active = this.getActive(frame.sessionId);
    if (active?.state !== "listening" || frame.source !== "candidate") return false;
    this.agent.sendInterviewPcmFrame(frame);
    return true;
  }

  acceptAudioCredit(sessionId: string, count: number): boolean {
    const active = this.getActive(sessionId);
    return (
      active?.state === "listening" &&
      Number.isSafeInteger(count) &&
      count > 0 &&
      count <= INTERVIEW_AUDIO_CREDIT_WINDOW
    );
  }

  private getActive(sessionId: string): ActiveCapture | undefined {
    return this.active?.sessionId === sessionId ? this.active : undefined;
  }
}

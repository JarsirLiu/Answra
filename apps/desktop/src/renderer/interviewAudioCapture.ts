import {
  ActiveInterviewConversationId,
  INTERVIEW_AUDIO_CREDIT_WINDOW,
  type InterviewPcmFrame,
} from "@answra/shared";
import type { InterviewCapturePort, InterviewCaptureState } from "@answra/ui";

interface WorkletFrameMessage {
  type: "frame";
  sequence: number;
  startSample: number;
  pcm: ArrayBuffer;
}

interface WorkletStoppedMessage {
  type: "stopped";
}

type WorkletMessage = WorkletFrameMessage | WorkletStoppedMessage;

interface CaptureRun {
  cancelled: boolean;
  sessionId?: string;
  sessionPromise?: Promise<{ sessionId: string }>;
  capturePromise?: Promise<MediaStream>;
  stream?: MediaStream;
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  worklet?: AudioWorkletNode;
  silentGain?: GainNode;
  stoppedWaiter?: () => void;
  cleanupPromise?: Promise<void>;
  stoppedTracks: Set<MediaStreamTrack>;
  availableCredits: number;
  agentConfirmedFrames: number;
  lastCreditAt: number;
  creditWatchdog?: ReturnType<typeof setTimeout>;
  stopPromise?: Promise<void>;
}

const AUDIO_CREDIT_TIMEOUT_MS = 3_000;

/** Renderer-only adapter: user gesture, MediaStream, Web Audio and PCM framing. */
export class InterviewAudioCapture implements InterviewCapturePort {
  private state: InterviewCaptureState = { phase: "idle" };
  private readonly listeners = new Set<(state: InterviewCaptureState) => void>();
  private run?: CaptureRun;

  constructor(private readonly bridge = window.answra) {
    bridge?.onInterviewAudioCredit?.((credit) => this.receiveAudioCredit(credit));
  }

  getState(): InterviewCaptureState {
    return this.state;
  }

  subscribe(listener: (state: InterviewCaptureState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.run) return;
    const bridge = this.bridge;
    if (
      !bridge?.startInterview ||
      !bridge.markInterviewCaptureReady ||
      !bridge.sendInterviewPcmFrame
    ) {
      this.setState({ phase: "error", message: "当前环境不支持系统声音采集" });
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.setState({ phase: "error", message: "当前系统不支持系统声音采集" });
      return;
    }

    const run: CaptureRun = {
      cancelled: false,
      availableCredits: INTERVIEW_AUDIO_CREDIT_WINDOW,
      agentConfirmedFrames: 0,
      lastCreditAt: Date.now(),
      stoppedTracks: new Set(),
    };
    this.run = run;
    this.setState({ phase: "starting" });
    try {
      // Start the main session and display-media request in the same click stack.
      run.sessionPromise = bridge.startInterview(ActiveInterviewConversationId);
      run.context = new AudioContext({ sampleRate: 16_000 });
      run.capturePromise = navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    } catch (error) {
      await this.finishFailedStart(run, error);
      return;
    }

    try {
      const [sessionResult, streamResult] = await Promise.allSettled([
        run.sessionPromise,
        run.capturePromise,
      ]);
      if (sessionResult.status === "fulfilled") run.sessionId = sessionResult.value.sessionId;
      if (streamResult.status === "fulfilled") run.stream = streamResult.value;
      if (sessionResult.status === "rejected") throw sessionResult.reason;
      if (streamResult.status === "rejected") throw streamResult.reason;
      if (run.cancelled || this.run !== run) {
        await this.cleanupRun(run);
        return;
      }

      const context = run.context;
      const stream = run.stream;
      if (context?.sampleRate !== 16_000) throw new Error("无法将音频转换为 16 kHz");
      if (!stream || stream.getAudioTracks().length === 0) throw new Error("没有获得系统声音音轨");
      for (const track of stream.getVideoTracks()) {
        track.stop();
        run.stoppedTracks.add(track);
      }
      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) throw new Error("没有获得系统声音音轨");
      audioTrack.addEventListener("ended", () => void this.failRun(run));

      await context.audioWorklet.addModule(
        new URL("pcmFrameProcessor.js", window.location.href).href,
      );
      if (run.cancelled || this.run !== run) return;
      run.source = context.createMediaStreamSource(stream);
      run.worklet = new AudioWorkletNode(context, "answra-pcm16-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      run.silentGain = context.createGain();
      run.silentGain.gain.value = 0;
      run.worklet.port.onmessage = (event: MessageEvent<WorkletMessage>) =>
        this.onWorkletMessage(run, event.data);
      run.worklet.addEventListener("processorerror", () => void this.failRun(run));
      run.source.connect(run.worklet).connect(run.silentGain).connect(context.destination);
      await context.resume();
      if (run.cancelled || this.run !== run) return;

      const sessionId = run.sessionId;
      if (!sessionId) throw new Error("面试采集会话未建立");
      await bridge.markInterviewCaptureReady(sessionId);
      if (run.cancelled || this.run !== run) return;
      run.worklet.port.postMessage({
        type: "start",
        credits: INTERVIEW_AUDIO_CREDIT_WINDOW,
        maxCredits: INTERVIEW_AUDIO_CREDIT_WINDOW,
      });
      this.setState({ phase: "listening", agentConfirmedFrames: 0 });
      this.scheduleCreditWatchdog(run);
    } catch (error) {
      await this.cleanupRun(run);
      if (run.cancelled || this.run !== run) return;
      run.cancelled = true;
      await this.failAgentRun(run);
      if (this.run === run) {
        this.run = undefined;
        this.setState({ phase: "error", message: captureErrorMessage(error) });
      }
    }
  }

  async stop(): Promise<void> {
    const run = this.run;
    if (!run) return;
    if (run.stopPromise) return run.stopPromise;
    run.cancelled = true;
    this.setState({ phase: "stopping" });
    run.stopPromise = this.finishStop(run);
    return run.stopPromise;
  }

  private async finishStop(run: CaptureRun): Promise<void> {
    const [sessionResult, captureResult] = await Promise.allSettled([
      run.sessionPromise,
      run.capturePromise,
    ]);
    if (sessionResult?.status === "fulfilled" && sessionResult.value)
      run.sessionId = sessionResult.value.sessionId;
    if (captureResult?.status === "fulfilled") run.stream = captureResult.value;
    if (run.worklet) {
      const stopped = new Promise<void>((resolve) => {
        run.stoppedWaiter = resolve;
      });
      run.worklet.port.postMessage({ type: "stop" });
      await Promise.race([stopped, new Promise<void>((resolve) => setTimeout(resolve, 250))]);
    }
    await this.cleanupRun(run);
    await this.stopAgentRun(run);
    if (this.run === run) {
      this.run = undefined;
      this.setState({ phase: "idle" });
    }
  }

  private onWorkletMessage(run: CaptureRun, message: WorkletMessage): void {
    if (message.type === "stopped") {
      run.stoppedWaiter?.();
      run.stoppedWaiter = undefined;
      return;
    }
    if (run.cancelled || this.run !== run) return;
    if (
      run.availableCredits <= 0 ||
      message.pcm.byteLength === 0 ||
      message.pcm.byteLength > 3_200 ||
      message.pcm.byteLength % 2 !== 0
    ) {
      void this.failRun(run);
      return;
    }
    run.availableCredits -= 1;
    const pcm = new Uint8Array(message.pcm);
    if (!run.sessionId) {
      void this.failRun(run);
      return;
    }
    const frame: InterviewPcmFrame = {
      sessionId: run.sessionId,
      source: "interviewer",
      sequence: message.sequence,
      startSample: message.startSample,
      sampleRate: 16_000,
      channels: 1,
      encoding: "pcm_s16le",
      pcm,
    };
    this.bridge?.sendInterviewPcmFrame?.(frame);
  }

  private receiveAudioCredit(credit: { sessionId: string; count: number }): void {
    const run = this.run;
    if (
      !run?.worklet ||
      run.cancelled ||
      run.sessionId !== credit.sessionId ||
      !Number.isSafeInteger(credit.count) ||
      credit.count <= 0
    )
      return;
    const granted = Math.min(credit.count, INTERVIEW_AUDIO_CREDIT_WINDOW - run.availableCredits);
    if (granted === 0) return;
    run.lastCreditAt = Date.now();
    run.availableCredits += granted;
    run.agentConfirmedFrames += granted;
    run.worklet.port.postMessage({ type: "credit", count: granted });
    this.setState({ phase: "listening", agentConfirmedFrames: run.agentConfirmedFrames });
    this.scheduleCreditWatchdog(run);
  }

  private scheduleCreditWatchdog(run: CaptureRun): void {
    if (run.creditWatchdog) clearTimeout(run.creditWatchdog);
    run.creditWatchdog = setTimeout(() => {
      run.creditWatchdog = undefined;
      if (run.cancelled || this.run !== run) return;
      if (
        run.availableCredits < INTERVIEW_AUDIO_CREDIT_WINDOW &&
        Date.now() - run.lastCreditAt >= AUDIO_CREDIT_TIMEOUT_MS
      ) {
        void this.failRun(run);
        return;
      }
      this.scheduleCreditWatchdog(run);
    }, AUDIO_CREDIT_TIMEOUT_MS);
  }

  private async failRun(run: CaptureRun): Promise<void> {
    if (run.cancelled) return;
    run.cancelled = true;
    await this.cleanupRun(run);
    await this.failAgentRun(run);
    if (this.run === run) {
      this.run = undefined;
      this.setState({ phase: "error", message: "系统声音采集已中断" });
    }
  }

  private async finishFailedStart(run: CaptureRun, error: unknown): Promise<void> {
    const session = await run.sessionPromise?.catch(() => undefined);
    const stream = await run.capturePromise?.catch(() => undefined);
    if (session) run.sessionId = session.sessionId;
    if (stream) run.stream = stream;
    await this.cleanupRun(run);
    await this.failAgentRun(run);
    if (this.run === run) {
      this.run = undefined;
      this.setState({ phase: "error", message: captureErrorMessage(error) });
    }
  }

  private async failAgentRun(run: CaptureRun): Promise<void> {
    if (run.sessionId)
      await this.bridge?.failInterviewCapture?.(run.sessionId).catch(() => undefined);
  }

  private async stopAgentRun(run: CaptureRun): Promise<void> {
    if (run.sessionId) await this.bridge?.stopInterview?.(run.sessionId).catch(() => undefined);
  }

  private async cleanupRun(run: CaptureRun): Promise<void> {
    if (run.cleanupPromise) return run.cleanupPromise;
    run.cleanupPromise = this.releaseRunResources(run);
    return run.cleanupPromise;
  }

  private async releaseRunResources(run: CaptureRun): Promise<void> {
    if (run.creditWatchdog) clearTimeout(run.creditWatchdog);
    run.creditWatchdog = undefined;
    run.worklet?.port.postMessage({ type: "stop" });
    run.worklet?.disconnect();
    run.source?.disconnect();
    run.silentGain?.disconnect();
    run.worklet = undefined;
    run.source = undefined;
    run.silentGain = undefined;
    for (const track of run.stream?.getTracks() ?? []) {
      if (run.stoppedTracks.has(track)) continue;
      track.stop();
      run.stoppedTracks.add(track);
    }
    run.stream = undefined;
    const context = run.context;
    run.context = undefined;
    if (context && context.state !== "closed") await context.close().catch(() => undefined);
  }

  private setState(state: InterviewCaptureState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

function captureErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "NotAllowedError") return "系统声音采集权限已取消";
    if (error.name === "NotFoundError") return "未找到可采集的系统声音";
    if (error.name === "NotReadableError") return "系统声音暂时无法读取";
    return error.message || "系统声音采集失败";
  }
  return "系统声音采集失败";
}

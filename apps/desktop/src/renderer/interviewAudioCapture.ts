import {
  ActiveInterviewConversationId,
  INTERVIEW_AUDIO_CREDIT_WINDOW,
  type InterviewAudioSource,
  type InterviewPcmFrame,
} from "@answra/shared";
import type { InterviewCapturePort, InterviewCaptureState } from "@answra/ui";
import { INTERVIEW_INPUT_LEVEL_WINDOW } from "@answra/ui";

interface WorkletFrameMessage {
  type: "frame";
  source: InterviewAudioSource;
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
  capturePromises: Map<InterviewAudioSource, Promise<MediaStream>>;
  inputs: Map<InterviewAudioSource, CaptureInput>;
  context?: AudioContext;
  cleanupPromise?: Promise<void>;
  stoppedTracks: Set<MediaStreamTrack>;
  availableCredits: number;
  agentConfirmedFrames: number;
  lastCreditAt: number;
  creditWatchdog?: ReturnType<typeof setTimeout>;
  levelTimer?: ReturnType<typeof setInterval>;
  inputLevels: number[];
  stopPromise?: Promise<void>;
}

interface CaptureInput {
  stream: MediaStream;
  source?: MediaStreamAudioSourceNode;
  worklet?: AudioWorkletNode;
  silentGain?: GainNode;
  analyser?: AnalyserNode;
}

const AUDIO_CREDIT_TIMEOUT_MS = 3_000;
/** 电平采样节拍：与 `INTERVIEW_INPUT_LEVEL_WINDOW` 共同决定滚动窗口时长。 */
export const INTERVIEW_INPUT_LEVEL_SAMPLE_MS = 40;

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
      this.setState({ phase: "error", message: "当前环境不支持面试音频采集" });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.setState({ phase: "error", message: "当前系统不支持面试音频采集" });
      return;
    }

    const run: CaptureRun = {
      cancelled: false,
      capturePromises: new Map(),
      inputs: new Map(),
      availableCredits: INTERVIEW_AUDIO_CREDIT_WINDOW,
      agentConfirmedFrames: 0,
      inputLevels: [],
      lastCreditAt: Date.now(),
      stoppedTracks: new Set(),
    };
    this.run = run;
    this.setState({ phase: "starting" });
    try {
      // Start the Agent session and microphone request from the user's click.
      run.sessionPromise = bridge.startInterview(ActiveInterviewConversationId);
      run.context = new AudioContext({ sampleRate: 16_000 });
      run.capturePromises.set(
        "candidate",
        // Chromium 对 audio:true 默认即启用 AEC/NS/AGC；这里显式钉死同一组值，
        // 防止设备或版本默认值漂移，也让采集意图可审计。注意 NS 的目标是
        // 平稳噪声，不覆盖远处人声——后者属通道归属与轮次判定的职责。
        navigator.mediaDevices.getUserMedia({
          audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true },
          video: false,
        }),
      );
    } catch (error) {
      await this.finishFailedStart(run, error);
      return;
    }

    try {
      const [sessionResult, ...streamResults] = await Promise.allSettled([
        run.sessionPromise,
        ...run.capturePromises.values(),
      ]);
      if (sessionResult.status === "fulfilled") run.sessionId = sessionResult.value.sessionId;
      if (sessionResult.status === "rejected") throw sessionResult.reason;
      const sources = [...run.capturePromises.keys()];
      for (const [index, result] of streamResults.entries()) {
        const source = sources[index];
        if (!source) throw new Error("音频来源顺序无效");
        if (result.status === "rejected") {
          throw new Error(captureErrorMessage(result.reason, source));
        }
        run.inputs.set(source, { stream: result.value });
      }
      if (run.cancelled || this.run !== run) {
        await this.cleanupRun(run);
        return;
      }

      const context = run.context;
      if (context?.sampleRate !== 16_000) throw new Error("无法将音频转换为 16 kHz");
      await context.audioWorklet.addModule(
        new URL("pcmFrameProcessor.js", window.location.href).href,
      );
      if (run.cancelled || this.run !== run) return;
      for (const [source, input] of run.inputs) {
        if (input.stream.getAudioTracks().length === 0)
          throw new Error(source === "interviewer" ? "没有获得系统声音音轨" : "没有获得麦克风音轨");
        input.stream.getAudioTracks()[0]?.addEventListener("ended", () => void this.failRun(run));
        input.source = context.createMediaStreamSource(input.stream);
        input.analyser = context.createAnalyser();
        input.analyser.fftSize = 256;
        input.analyser.smoothingTimeConstant = 0.15;
        input.worklet = new AudioWorkletNode(context, "answra-pcm16-capture", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        input.silentGain = context.createGain();
        input.silentGain.gain.value = 0;
        input.worklet.port.onmessage = (event: MessageEvent<WorkletMessage>) =>
          this.onWorkletMessage(run, event.data);
        input.worklet.addEventListener("processorerror", () => void this.failRun(run));
        input.source.connect(input.worklet).connect(input.silentGain).connect(context.destination);
        input.source.connect(input.analyser).connect(input.silentGain);
      }
      await context.resume();
      if (run.cancelled || this.run !== run) return;

      const sessionId = run.sessionId;
      if (!sessionId) throw new Error("面试采集会话未建立");
      await bridge.markInterviewCaptureReady(sessionId);
      if (run.cancelled || this.run !== run) return;
      const initialCredits = INTERVIEW_AUDIO_CREDIT_WINDOW;
      for (const [source, input] of run.inputs) {
        input.worklet?.port.postMessage({
          type: "start",
          source,
          credits: initialCredits,
          maxCredits: INTERVIEW_AUDIO_CREDIT_WINDOW,
        });
      }
      this.setState({
        phase: "listening",
        agentConfirmedFrames: 0,
        inputLevels: [],
      });
      run.levelTimer = setInterval(
        () => this.sampleInputLevel(run),
        INTERVIEW_INPUT_LEVEL_SAMPLE_MS,
      );
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
    const [sessionResult, ...streamResults] = await Promise.allSettled([
      run.sessionPromise,
      ...run.capturePromises.values(),
    ]);
    if (sessionResult?.status === "fulfilled" && sessionResult.value)
      run.sessionId = sessionResult.value.sessionId;
    const sources = [...run.capturePromises.keys()];
    for (const [index, result] of streamResults.entries()) {
      const source = sources[index];
      if (result.status === "fulfilled" && source && !run.inputs.has(source))
        run.inputs.set(source, { stream: result.value });
    }
    const stoppingWorklets = [...run.inputs.values()].flatMap((input) =>
      input.worklet ? [stopWorklet(input.worklet)] : [],
    );
    await Promise.all(stoppingWorklets);
    await this.cleanupRun(run);
    await this.stopAgentRun(run);
    if (this.run === run) {
      this.run = undefined;
      this.setState({ phase: "idle", inputLevels: [] });
    }
  }

  private onWorkletMessage(run: CaptureRun, message: WorkletMessage): void {
    if (message.type === "stopped") {
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
      source: message.source,
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
      !run ||
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
    run.inputs.get("candidate")?.worklet?.port.postMessage({ type: "credit", count: granted });
    this.setState({
      phase: "listening",
      agentConfirmedFrames: run.agentConfirmedFrames,
    });
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
      this.setState({ phase: "error", message: "面试音频采集已中断" });
    }
  }

  private async finishFailedStart(run: CaptureRun, error: unknown): Promise<void> {
    const session = await run.sessionPromise?.catch(() => undefined);
    const streams = await Promise.all(
      [...run.capturePromises].map(
        async ([source, promise]) => [source, await promise.catch(() => undefined)] as const,
      ),
    );
    if (session) run.sessionId = session.sessionId;
    for (const [source, stream] of streams)
      if (stream && !run.inputs.has(source)) run.inputs.set(source, { stream });
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
    if (run.levelTimer) clearInterval(run.levelTimer);
    run.levelTimer = undefined;
    for (const input of run.inputs.values()) {
      input.worklet?.port.postMessage({ type: "stop" });
      input.worklet?.disconnect();
      input.source?.disconnect();
      input.silentGain?.disconnect();
      input.analyser?.disconnect();
      for (const track of input.stream.getTracks()) {
        if (run.stoppedTracks.has(track)) continue;
        track.stop();
        run.stoppedTracks.add(track);
      }
    }
    run.inputs.clear();
    const context = run.context;
    run.context = undefined;
    if (context && context.state !== "closed") await context.close().catch(() => undefined);
  }

  private setState(state: InterviewCaptureState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  private sampleInputLevel(run: CaptureRun): void {
    if (run.cancelled || this.run !== run) return;
    const analyser = run.inputs.get("candidate")?.analyser;
    if (!analyser) return;
    const samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    let sumSquares = 0;
    for (const sample of samples) sumSquares += sample * sample;
    const level = Math.min(1, Math.sqrt(sumSquares / samples.length) * 12);
    run.inputLevels.push(level);
    if (run.inputLevels.length > INTERVIEW_INPUT_LEVEL_WINDOW) run.inputLevels.shift();
    this.setState({
      phase: this.state.phase,
      agentConfirmedFrames: run.agentConfirmedFrames,
      inputLevels: [...run.inputLevels],
    });
  }
}

async function stopWorklet(worklet: AudioWorkletNode): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 250);
    const onStopped = (event: MessageEvent<WorkletMessage>) => {
      if (event.data.type !== "stopped") return;
      clearTimeout(timeout);
      worklet.port.removeEventListener("message", onStopped);
      resolve();
    };
    worklet.port.addEventListener("message", onStopped);
    worklet.port.postMessage({ type: "stop" });
  });
}

function captureErrorMessage(error: unknown, source?: InterviewAudioSource): string {
  if (error instanceof Error) {
    if (error.name === "NotAllowedError")
      return source === "candidate"
        ? "麦克风权限被拒绝或已取消，请检查 Windows 麦克风隐私设置"
        : source === "interviewer"
          ? "系统声音捕获被拒绝或已取消，请重试系统音频捕获"
          : "音频权限被拒绝或已取消";
    if (error.name === "NotFoundError")
      return source === "candidate"
        ? "未找到麦克风设备"
        : source === "interviewer"
          ? "未找到系统声音来源"
          : "未找到音频设备";
    if (error.name === "NotReadableError")
      return source === "candidate"
        ? "麦克风暂时无法读取，可能正被其它程序占用"
        : source === "interviewer"
          ? "系统声音暂时无法读取"
          : "音频设备暂时无法读取";
    return error.message || "面试音频采集失败";
  }
  return "面试音频采集失败";
}

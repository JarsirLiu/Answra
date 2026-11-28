/**
 * 面试语音输入的 renderer 适配器：用户手势内申请麦克风，用 AudioWorklet 重采样成
 * 16 kHz PCM16 帧，再经 bridge 交给 main/Agent。凭证、会话 ID 与领域判断都在主进程。
 */
import type { DesktopBridge, InterviewPcmFrame } from "@answra/shared";
import { INTERVIEW_AUDIO_CREDIT_WINDOW } from "@answra/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { toUserFacingFailure } from "../../modelFailure";

const AUDIO_CREDIT_TIMEOUT_MS = 3_000;
const MAX_FRAME_BYTES = 3_200;
const WORKLET_NAME = "answra-pcm16-capture";

interface WorkletFrameMessage {
  type: "frame";
  source: "candidate";
  sequence: number;
  startSample: number;
  pcm: ArrayBuffer;
}

interface WorkletLevelMessage {
  type: "level";
  level: number;
}

interface WorkletStoppedMessage {
  type: "stopped";
}

type WorkletMessage = WorkletFrameMessage | WorkletLevelMessage | WorkletStoppedMessage;

interface CaptureRun {
  cancelled: boolean;
  sessionId?: string;
  sessionPromise?: Promise<{ sessionId: string }>;
  stream?: MediaStream;
  context?: AudioContext;
  sourceNode?: MediaStreamAudioSourceNode;
  worklet?: AudioWorkletNode;
  silentGain?: GainNode;
  availableCredits: number;
  lastCreditAt: number;
  creditWatchdog?: ReturnType<typeof setTimeout>;
  cleanupPromise?: Promise<void>;
  stopPromise?: Promise<void>;
}

export interface InterviewMicrophoneHandle {
  /** 已经过主进程确认、正在接收音频帧。 */
  active: boolean;
  starting: boolean;
  error?: string;
  /** 失败来自模型调用门禁（未登录 / 未配置模型），属于正常引导而不是采集故障。 */
  modelFailure: boolean;
  needsSignIn: boolean;
  needsModelSetup: boolean;
  /** 来自 worklet 的 0..1 输入电平，供后续波形展示使用。 */
  level: number;
  toggle: () => void;
  stop: () => Promise<void>;
}

type MicrophonePatch = Partial<
  Pick<
    InterviewMicrophoneHandle,
    "active" | "starting" | "error" | "level" | "modelFailure" | "needsSignIn" | "needsModelSetup"
  >
>;

/** 只处理 candidate（麦克风）一路；面试官声音采集不在本项目范围。 */
export function useInterviewMicrophone(
  platform: DesktopBridge | undefined,
  conversationId: string,
): InterviewMicrophoneHandle {
  const [starting, setStarting] = useState(false);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string>();
  const [modelFailure, setModelFailure] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [needsModelSetup, setNeedsModelSetup] = useState(false);
  const [level, setLevel] = useState(0);
  const runRef = useRef<CaptureRun | undefined>(undefined);
  const mountedRef = useRef(true);

  const publish = useCallback((patch: MicrophonePatch) => {
    if (!mountedRef.current) return;
    if (patch.starting !== undefined) setStarting(patch.starting);
    if (patch.active !== undefined) setActive(patch.active);
    if (patch.error !== undefined) setError(patch.error);
    if (patch.level !== undefined) setLevel(patch.level);
    if (patch.modelFailure !== undefined) setModelFailure(patch.modelFailure);
    if (patch.needsSignIn !== undefined) setNeedsSignIn(patch.needsSignIn);
    if (patch.needsModelSetup !== undefined) setNeedsModelSetup(patch.needsModelSetup);
  }, []);

  const cleanup = useCallback(async (run: CaptureRun) => {
    if (run.cleanupPromise) return run.cleanupPromise;
    run.cleanupPromise = (async () => {
      if (run.creditWatchdog) clearTimeout(run.creditWatchdog);
      run.creditWatchdog = undefined;
      if (run.worklet) {
        run.worklet.port.postMessage({ type: "stop" });
        run.worklet.disconnect();
      }
      run.sourceNode?.disconnect();
      run.silentGain?.disconnect();
      for (const track of run.stream?.getTracks() ?? []) track.stop();
      const context = run.context;
      run.context = undefined;
      if (context && context.state !== "closed") await context.close().catch(() => undefined);
    })();
    return run.cleanupPromise;
  }, []);

  const failAgent = useCallback(
    async (run: CaptureRun) => {
      if (run.sessionId)
        await platform?.failInterviewCapture?.(run.sessionId).catch(() => undefined);
    },
    [platform],
  );

  const fail = useCallback(
    async (run: CaptureRun, reason?: unknown, kind: "model" | "capture" = "capture") => {
      if (run.cancelled) return;
      run.cancelled = true;
      await cleanup(run);
      await failAgent(run);
      if (runRef.current === run) {
        runRef.current = undefined;
        if (kind === "model") {
          const failure = toUserFacingFailure(reason, "无法开始语音输入");
          publish({
            starting: false,
            active: false,
            error: failure.message,
            modelFailure: true,
            needsSignIn: failure.needsSignIn,
            needsModelSetup: failure.needsModelSetup,
          });
        } else {
          publish({
            starting: false,
            active: false,
            error: captureErrorMessage(reason),
            modelFailure: false,
            needsSignIn: false,
            needsModelSetup: false,
          });
        }
      }
    },
    [cleanup, failAgent, publish],
  );

  const scheduleCreditWatchdog = useCallback(
    (run: CaptureRun) => {
      if (run.creditWatchdog) clearTimeout(run.creditWatchdog);
      run.creditWatchdog = setTimeout(() => {
        run.creditWatchdog = undefined;
        if (run.cancelled || runRef.current !== run) return;
        if (
          run.availableCredits < INTERVIEW_AUDIO_CREDIT_WINDOW &&
          Date.now() - run.lastCreditAt >= AUDIO_CREDIT_TIMEOUT_MS
        ) {
          void fail(run);
          return;
        }
        scheduleCreditWatchdog(run);
      }, AUDIO_CREDIT_TIMEOUT_MS);
    },
    [fail],
  );

  const handleWorkletMessage = useCallback(
    (run: CaptureRun, message: WorkletMessage) => {
      if (message.type === "stopped") return;
      if (run.cancelled || runRef.current !== run) return;
      if (message.type === "level") {
        const level = Number.isFinite(message.level) ? Math.min(1, Math.max(0, message.level)) : 0;
        publish({ level });
        return;
      }
      if (
        run.availableCredits <= 0 ||
        message.pcm.byteLength === 0 ||
        message.pcm.byteLength > MAX_FRAME_BYTES ||
        message.pcm.byteLength % 2 !== 0 ||
        !run.sessionId
      ) {
        void fail(run);
        return;
      }
      run.availableCredits -= 1;
      const frame: InterviewPcmFrame = {
        sessionId: run.sessionId,
        source: "candidate",
        sequence: message.sequence,
        startSample: message.startSample,
        sampleRate: 16_000,
        channels: 1,
        encoding: "pcm_s16le",
        pcm: new Uint8Array(message.pcm),
      };
      platform?.sendInterviewPcmFrame?.(frame);
    },
    [fail, platform, publish],
  );

  const stop = useCallback(async () => {
    const run = runRef.current;
    if (!run) return;
    if (run.stopPromise) return run.stopPromise;
    run.cancelled = true;
    run.stopPromise = (async () => {
      publish({ starting: false, active: false, level: 0 });
      await cleanup(run);
      if (run.sessionId) await platform?.stopInterview?.(run.sessionId).catch(() => undefined);
      if (runRef.current === run) runRef.current = undefined;
    })();
    return run.stopPromise;
  }, [cleanup, platform, publish]);

  const start = useCallback(async () => {
    if (runRef.current) return;
    if (
      !platform?.startInterview ||
      !platform.markInterviewCaptureReady ||
      !platform.sendInterviewPcmFrame ||
      !platform.failInterviewCapture ||
      !platform.stopInterview
    ) {
      publish({
        error: "当前版本不支持语音输入",
        starting: false,
        active: false,
        modelFailure: false,
        needsSignIn: false,
        needsModelSetup: false,
      });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
      publish({
        error: "当前系统不支持语音输入",
        starting: false,
        active: false,
        modelFailure: false,
        needsSignIn: false,
        needsModelSetup: false,
      });
      return;
    }

    const run: CaptureRun = {
      cancelled: false,
      availableCredits: INTERVIEW_AUDIO_CREDIT_WINDOW,
      lastCreditAt: Date.now(),
    };
    runRef.current = run;
    publish({
      starting: true,
      active: false,
      error: undefined,
      level: 0,
      modelFailure: false,
      needsSignIn: false,
      needsModelSetup: false,
    });

    try {
      // 必须在用户手势内同时发起会话与麦克风申请：主进程只在 starting 态放开媒体权限。
      run.sessionPromise = platform.startInterview(conversationId);
      const streamPromise = navigator.mediaDevices.getUserMedia({
        audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      const [sessionResult, streamResult] = await Promise.allSettled([
        run.sessionPromise,
        streamPromise,
      ]);
      // 模型门禁在 startInterview：未登录/未配置模型是正常引导，不当成采集故障。
      if (sessionResult.status === "rejected") {
        await fail(run, sessionResult.reason, "model");
        return;
      }
      run.sessionId = sessionResult.value.sessionId;
      if (streamResult.status === "rejected") {
        await fail(run, streamResult.reason, "capture");
        return;
      }
      run.stream = streamResult.value;
      if (run.cancelled || runRef.current !== run) {
        await cleanup(run);
        return;
      }

      // 不强制 16 kHz：设备原生采样率交给 worklet 做分数相位重采样。
      const context = new AudioContext();
      run.context = context;
      await context.audioWorklet.addModule(new URL("pcmFrameProcessor.js", document.baseURI).href);
      if (run.cancelled || runRef.current !== run) {
        await cleanup(run);
        return;
      }

      const track = run.stream.getAudioTracks()[0];
      if (!track) throw new Error("没有获得麦克风音轨");
      track.addEventListener("ended", () => void fail(run));
      run.sourceNode = context.createMediaStreamSource(run.stream);
      run.worklet = new AudioWorkletNode(context, WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      run.silentGain = context.createGain();
      run.silentGain.gain.value = 0;
      run.worklet.port.onmessage = (event: MessageEvent<WorkletMessage>) =>
        handleWorkletMessage(run, event.data);
      run.worklet.addEventListener("processorerror", () => void fail(run));
      run.sourceNode.connect(run.worklet).connect(run.silentGain).connect(context.destination);
      await context.resume();
      if (run.cancelled || runRef.current !== run) {
        await cleanup(run);
        return;
      }

      await platform.markInterviewCaptureReady(run.sessionId);
      if (run.cancelled || runRef.current !== run) {
        await cleanup(run);
        return;
      }
      run.worklet.port.postMessage({
        type: "start",
        source: "candidate",
        sampleRate: context.sampleRate,
        credits: INTERVIEW_AUDIO_CREDIT_WINDOW,
        maxCredits: INTERVIEW_AUDIO_CREDIT_WINDOW,
      });
      publish({ starting: false, active: true });
      scheduleCreditWatchdog(run);
    } catch (error) {
      await fail(run, error);
    }
  }, [
    cleanup,
    conversationId,
    fail,
    handleWorkletMessage,
    platform,
    publish,
    scheduleCreditWatchdog,
  ]);

  // 只订阅 agent 的 credit 推送；会话归属由 run.sessionId 校验。
  useEffect(() => {
    return platform?.onInterviewAudioCredit?.((credit) => {
      const run = runRef.current;
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
      run.availableCredits += granted;
      run.lastCreditAt = Date.now();
      run.worklet?.port.postMessage({ type: "credit", count: granted });
      scheduleCreditWatchdog(run);
    });
  }, [platform, scheduleCreditWatchdog]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (runRef.current) void stop();
    };
  }, [stop]);

  const toggle = useCallback(() => {
    if (runRef.current) void stop();
    else void start();
  }, [start, stop]);

  return {
    active,
    starting,
    error,
    modelFailure,
    needsSignIn,
    needsModelSetup,
    level,
    toggle,
    stop,
  };
}

function captureErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "NotAllowedError")
      return "麦克风权限被拒绝或已取消，请检查 Windows 麦克风隐私设置";
    if (error.name === "NotFoundError") return "未找到麦克风设备";
    if (error.name === "NotReadableError") return "麦克风暂时无法读取，可能正被其它程序占用";
  }
  // 非设备类失败也可能是 IPC 抛上来的，统一剥外壳，不再把调试文本给用户。
  return toUserFacingFailure(error, "语音输入失败").message;
}

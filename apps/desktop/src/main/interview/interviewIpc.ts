import {
  ActiveInterviewConversationId,
  InterviewChannels,
  type InterviewPcmFrame,
} from "@answra/shared";
import {
  type BrowserWindow,
  desktopCapturer,
  type IpcMainEvent,
  ipcMain,
  screen,
  session,
} from "electron";
import type { AgentService } from "../conversation/agentService";
import { getWindow, isWindowFromSender } from "../window";
import { InterviewCaptureService } from "./interviewCaptureService";

/** IPC and Electron display-media authorization for Windows system loopback audio. */
export function registerInterviewIpc(agent: AgentService) {
  const capture = new InterviewCaptureService(agent);

  ipcMain.handle(InterviewChannels.Start, async (event, payload: unknown) => {
    const window = getWindow();
    if (!isWindowFromSender(window, event)) throw new Error("非法调用方");
    if (
      typeof payload !== "object" ||
      payload === null ||
      (payload as { conversationId?: unknown }).conversationId !== ActiveInterviewConversationId
    )
      throw new Error("面试会话无效");

    const result = await capture.start(ActiveInterviewConversationId);
    publishState(result.sessionId, "connecting");
    return result;
  });

  ipcMain.handle(InterviewChannels.CaptureReady, async (event, payload: unknown) => {
    if (!isWindowFromSender(getWindow(), event) || !isSessionPayload(payload))
      throw new Error("非法调用方");
    if (!(await capture.captureReady(payload.sessionId))) throw new Error("面试采集会话已失效");
    publishState(payload.sessionId, "listening");
  });

  ipcMain.handle(InterviewChannels.CaptureFailed, async (event, payload: unknown) => {
    if (!isWindowFromSender(getWindow(), event) || !isSessionPayload(payload))
      throw new Error("非法调用方");
    if (await capture.fail(payload.sessionId)) publishState(payload.sessionId, "error");
  });

  ipcMain.handle(InterviewChannels.Stop, async (event, payload: unknown) => {
    if (!isWindowFromSender(getWindow(), event) || !isSessionPayload(payload))
      throw new Error("非法调用方");
    if (await capture.stop(payload.sessionId)) publishState(payload.sessionId, "stopped");
  });

  const onAudioFrame = (event: IpcMainEvent, frame: unknown) => {
    if (!isWindowFromSender(getWindow(), event) || !isPcmFrame(frame)) return;
    capture.acceptFrame(frame);
  };
  ipcMain.on(InterviewChannels.AudioFrame, onAudioFrame);
  const unsubscribeAudioCredits = agent.onInterviewAudioCredit((credit) => {
    if (!capture.acceptAudioCredit(credit.sessionId, credit.count)) return;
    getWindow()?.webContents.send(InterviewChannels.AudioCredit, credit);
  });

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const window = getWindow();
    if (
      process.platform !== "win32" ||
      !window ||
      request.frame !== window.webContents.mainFrame ||
      !request.userGesture ||
      !request.videoRequested ||
      !request.audioRequested
    ) {
      callback({});
      return;
    }
    const captureSessionId = capture.claimDisplayRequest();
    if (!captureSessionId) {
      callback({});
      return;
    }

    void desktopCapturer
      .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        if (!capture.isStartingSession(captureSessionId)) {
          callback({});
          return;
        }
        const primaryDisplayId = String(screen.getPrimaryDisplay().id);
        const source =
          sources.find((candidate) => candidate.display_id === primaryDisplayId) ?? sources[0];
        if (!source) {
          capture.releaseDisplayRequest(captureSessionId);
          callback({});
          return;
        }
        callback({ video: source, audio: "loopback" });
      })
      .catch(() => {
        capture.releaseDisplayRequest(captureSessionId);
        callback({});
      });
  });

  return {
    async stopActive(): Promise<void> {
      await capture.stopActive();
    },
    bindWindow(window: BrowserWindow): void {
      window.once("closed", () => {
        void capture.stopActive().catch((error: unknown) => {
          console.warn("[interview] failed to stop capture after window close", error);
        });
      });
    },
    dispose(): void {
      session.defaultSession.setDisplayMediaRequestHandler(null);
      ipcMain.removeHandler(InterviewChannels.Start);
      ipcMain.removeHandler(InterviewChannels.CaptureReady);
      ipcMain.removeHandler(InterviewChannels.CaptureFailed);
      ipcMain.removeHandler(InterviewChannels.Stop);
      ipcMain.removeListener(InterviewChannels.AudioFrame, onAudioFrame);
      unsubscribeAudioCredits();
    },
  };
}

function publishState(sessionId: string, state: "connecting" | "listening" | "stopped" | "error") {
  getWindow()?.webContents.send(InterviewChannels.Change, {
    sessionId,
    type: "state",
    state,
  });
}

function isSessionPayload(value: unknown): value is { sessionId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { sessionId?: unknown }).sessionId === "string" &&
    (value as { sessionId: string }).sessionId.length > 0 &&
    (value as { sessionId: string }).sessionId.length <= 128
  );
}

function isPcmFrame(value: unknown): value is InterviewPcmFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Partial<InterviewPcmFrame>;
  return (
    typeof frame.sessionId === "string" &&
    frame.sessionId.length > 0 &&
    frame.sessionId.length <= 128 &&
    frame.source === "interviewer" &&
    Number.isSafeInteger(frame.sequence) &&
    (frame.sequence ?? -1) >= 0 &&
    Number.isSafeInteger(frame.startSample) &&
    (frame.startSample ?? -1) >= 0 &&
    frame.sampleRate === 16_000 &&
    frame.channels === 1 &&
    frame.encoding === "pcm_s16le" &&
    frame.pcm instanceof Uint8Array &&
    frame.pcm.byteLength > 0 &&
    frame.pcm.byteLength <= 3_200 &&
    frame.pcm.byteLength % 2 === 0
  );
}

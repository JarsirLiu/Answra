import {
  ActiveInterviewConversationId,
  type InterviewAudioSource,
  type InterviewChange,
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
  const unsubscribeInterviewEvents = agent.onInterviewEvent((event) => {
    if (event.type !== "transcript-event" || event.event.kind !== "chunk-final") return;
    const transcript: InterviewChange = {
      sessionId: event.event.sessionId,
      type: "transcript",
      speaker: event.event.source === "interviewer" ? "interviewer" : "user",
      utteranceId: event.event.utteranceId,
      chunkIndex: event.event.chunkIndex,
      text: event.event.text,
      final: true,
      turnEnd: event.event.boundary === "utterance-end",
      timestamp: Date.now(),
    };
    getWindow()?.webContents.send(InterviewChannels.Change, transcript);
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
      console.warn("[interview] system audio request denied", {
        platform: process.platform,
        mainFrame: request.frame === window?.webContents.mainFrame,
        userGesture: request.userGesture,
        videoRequested: request.videoRequested,
        audioRequested: request.audioRequested,
      });
      callback({});
      return;
    }
    const captureSessionId = capture.claimDisplayRequest();
    if (!captureSessionId) {
      console.warn("[interview] system audio request denied: no starting capture session");
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
          console.warn("[interview] system audio request denied: no screen source available");
          capture.releaseDisplayRequest(captureSessionId);
          callback({});
          return;
        }
        callback({ video: source, audio: "loopback" });
      })
      .catch((error: unknown) => {
        console.warn("[interview] failed to enumerate system audio source", error);
        capture.releaseDisplayRequest(captureSessionId);
        callback({});
      });
  });
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const window = getWindow();
      const trustedMainFrame = details.isMainFrame && window?.webContents === webContents;
      const isAuthorizedMicrophoneRequest =
        permission === "media" &&
        trustedMainFrame &&
        details.mediaTypes?.length === 1 &&
        details.mediaTypes[0] === "audio" &&
        capture.allowsMicrophonePermission();
      const isAuthorizedDisplayRequest =
        permission === "display-capture" &&
        trustedMainFrame &&
        capture.allowsMicrophonePermission();
      const isDisplayMediaRequest =
        permission === "media" &&
        trustedMainFrame &&
        (details.mediaTypes === undefined ||
          details.mediaTypes.length === 0 ||
          details.mediaTypes.includes("video")) &&
        capture.claimDisplayMediaPermission();
      const authorized =
        isAuthorizedMicrophoneRequest || isAuthorizedDisplayRequest || isDisplayMediaRequest;
      if (!authorized && (permission === "media" || permission === "display-capture")) {
        console.warn("[interview] media permission denied", {
          permission,
          trustedMainFrame,
          mediaTypes: details.mediaTypes,
          captureStarting: capture.allowsMicrophonePermission(),
        });
      }
      callback(authorized);
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, _requestingOrigin, details) => {
      const window = getWindow();
      return (
        permission === "media" &&
        webContents === window?.webContents &&
        details.isMainFrame &&
        details.mediaType === "audio" &&
        capture.allowsMicrophonePermission()
      );
    },
  );

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
      session.defaultSession.setPermissionRequestHandler(null);
      session.defaultSession.setPermissionCheckHandler(null);
      ipcMain.removeHandler(InterviewChannels.Start);
      ipcMain.removeHandler(InterviewChannels.CaptureReady);
      ipcMain.removeHandler(InterviewChannels.CaptureFailed);
      ipcMain.removeHandler(InterviewChannels.Stop);
      ipcMain.removeListener(InterviewChannels.AudioFrame, onAudioFrame);
      unsubscribeAudioCredits();
      unsubscribeInterviewEvents();
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
    isInterviewAudioSource(frame.source) &&
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

function isInterviewAudioSource(value: unknown): value is InterviewAudioSource {
  return value === "interviewer" || value === "candidate";
}

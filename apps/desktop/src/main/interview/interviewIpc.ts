import {
  ActiveInterviewConversationId,
  InterviewChannels,
  type InterviewPcmFrame,
} from "@answra/shared";
import { type BrowserWindow, type IpcMainEvent, ipcMain, session } from "electron";
import type { AgentService } from "../conversation/agentService";
import { getWindow, isWindowFromSender } from "../window";
import { InterviewCaptureService } from "./interviewCaptureService";

/** IPC and permission boundary for the current microphone-only interview input. */
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

    return capture.start(ActiveInterviewConversationId);
  });

  ipcMain.handle(InterviewChannels.CaptureReady, async (event, payload: unknown) => {
    if (!isWindowFromSender(getWindow(), event) || !isSessionPayload(payload))
      throw new Error("非法调用方");
    if (!(await capture.captureReady(payload.sessionId))) throw new Error("面试采集会话已失效");
  });

  ipcMain.handle(InterviewChannels.CaptureFailed, async (event, payload: unknown) => {
    if (!isWindowFromSender(getWindow(), event) || !isSessionPayload(payload))
      throw new Error("非法调用方");
    await capture.fail(payload.sessionId);
  });

  ipcMain.handle(InterviewChannels.Stop, async (event, payload: unknown) => {
    if (!isWindowFromSender(getWindow(), event) || !isSessionPayload(payload))
      throw new Error("非法调用方");
    await capture.stop(payload.sessionId);
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

  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
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
      const authorized = isAuthorizedMicrophoneRequest;
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
    },
  };
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
    frame.source === "candidate" &&
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

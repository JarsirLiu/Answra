import { ActiveInterviewConversationId, InterviewChannels } from "@answra/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const mainFrame = {};
  const window = { webContents: { mainFrame, send: vi.fn() } };
  return {
    handlers,
    listeners,
    mainFrame,
    window,
    displayHandler: undefined as
      | ((request: unknown, callback: (streams: unknown) => void) => void)
      | undefined,
    permissionHandler: undefined as
      | ((
          webContents: unknown,
          permission: string,
          callback: (granted: boolean) => void,
          details: unknown,
        ) => void)
      | undefined,
    permissionCheckHandler: undefined as
      | ((webContents: unknown, permission: string, origin: string, details: unknown) => boolean)
      | undefined,
    getSources: vi.fn(async () => [{ id: "screen:1:0", display_id: "1" }]),
    getPrimaryDisplay: vi.fn(() => ({ id: 1 })),
    sendInterviewPcmFrame: vi.fn(),
    audioCreditListener: undefined as
      | ((credit: { sessionId: string; count: number }) => void)
      | undefined,
    startInterview: vi.fn(async () => undefined),
    markInterviewCaptureReady: vi.fn(async () => undefined),
    failInterviewCapture: vi.fn(async () => undefined),
    stopInterview: vi.fn(async () => undefined),
  };
});

vi.mock("electron", () => ({
  desktopCapturer: { getSources: harness.getSources },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      harness.handlers.set(channel, handler),
    on: (channel: string, listener: (...args: unknown[]) => unknown) =>
      harness.listeners.set(channel, listener),
    removeHandler: (channel: string) => harness.handlers.delete(channel),
    removeListener: (channel: string) => harness.listeners.delete(channel),
  },
  screen: { getPrimaryDisplay: harness.getPrimaryDisplay },
  session: {
    defaultSession: {
      setDisplayMediaRequestHandler: (handler: unknown) => {
        harness.displayHandler = handler as typeof harness.displayHandler;
      },
      setPermissionRequestHandler: (handler: unknown) => {
        harness.permissionHandler = handler as typeof harness.permissionHandler;
      },
      setPermissionCheckHandler: (handler: unknown) => {
        harness.permissionCheckHandler = handler as typeof harness.permissionCheckHandler;
      },
    },
  },
}));

vi.mock("../src/main/window", () => ({
  getWindow: () => harness.window,
  isWindowFromSender: (window: typeof harness.window, event: { sender: unknown }) =>
    event.sender === window?.webContents,
}));

import type { AgentService } from "../src/main/conversation/agentService";
import { registerInterviewIpc } from "../src/main/interview/interviewIpc";

describe("interview IPC", () => {
  afterEach(() => {
    harness.handlers.clear();
    harness.listeners.clear();
    harness.displayHandler = undefined;
    harness.permissionHandler = undefined;
    harness.permissionCheckHandler = undefined;
    harness.audioCreditListener = undefined;
    vi.clearAllMocks();
  });

  it("authorizes microphone-only capture and forwards candidate PCM", async () => {
    const agent = {
      startInterview: harness.startInterview,
      markInterviewCaptureReady: harness.markInterviewCaptureReady,
      failInterviewCapture: harness.failInterviewCapture,
      stopInterview: harness.stopInterview,
      sendInterviewPcmFrame: harness.sendInterviewPcmFrame,
      onInterviewAudioCredit: (
        listener: (credit: { sessionId: string; count: number }) => void,
      ) => {
        harness.audioCreditListener = listener;
        return vi.fn();
      },
    } as unknown as AgentService;
    const ipc = registerInterviewIpc(agent);
    const senderEvent = { sender: harness.window.webContents };
    const start = harness.handlers.get(InterviewChannels.Start);
    if (!start) throw new Error("start handler not registered");
    const result = (await start(senderEvent, {
      conversationId: ActiveInterviewConversationId,
    })) as { sessionId: string };
    expect(agent.startInterview).toHaveBeenCalledWith(
      result.sessionId,
      ActiveInterviewConversationId,
    );

    const permissionHandler = harness.permissionHandler;
    if (!permissionHandler) throw new Error("microphone permission handler not registered");
    const permissionCheckHandler = harness.permissionCheckHandler;
    if (!permissionCheckHandler) throw new Error("media permission check handler not registered");
    expect(
      permissionCheckHandler(harness.window.webContents, "media", "app://local", {
        isMainFrame: true,
        mediaType: "audio",
      }),
    ).toBe(true);
    expect(
      permissionCheckHandler(harness.window.webContents, "media", "app://local", {
        isMainFrame: true,
        mediaType: "video",
      }),
    ).toBe(false);
    const microphonePermission = vi.fn();
    permissionHandler(harness.window.webContents, "media", microphonePermission, {
      isMainFrame: true,
      mediaTypes: ["audio"],
    });
    expect(microphonePermission).toHaveBeenCalledWith(true);
    const displayPermission = vi.fn();
    permissionHandler(harness.window.webContents, "display-capture", displayPermission, {
      isMainFrame: true,
    });
    expect(displayPermission).toHaveBeenCalledWith(false);
    const displayMediaPermission = vi.fn();
    permissionHandler(harness.window.webContents, "media", displayMediaPermission, {
      isMainFrame: true,
      mediaTypes: [],
    });
    expect(displayMediaPermission).toHaveBeenCalledWith(false);
    const secondDisplayMediaPermission = vi.fn();
    permissionHandler(harness.window.webContents, "media", secondDisplayMediaPermission, {
      isMainFrame: true,
      mediaTypes: [],
    });
    expect(secondDisplayMediaPermission).toHaveBeenCalledWith(false);

    const displayHandler = harness.displayHandler;
    if (!displayHandler) throw new Error("display media handler not registered");
    const denied = vi.fn();
    displayHandler(
      {
        frame: harness.mainFrame,
        userGesture: false,
        videoRequested: true,
        audioRequested: true,
      },
      denied,
    );
    expect(denied).toHaveBeenCalledWith({});
    expect(harness.getSources).not.toHaveBeenCalled();

    const deniedByGesture = vi.fn();
    displayHandler(
      { frame: harness.mainFrame, userGesture: true, videoRequested: true, audioRequested: true },
      deniedByGesture,
    );
    expect(deniedByGesture).toHaveBeenCalledWith({});
    expect(harness.getSources).not.toHaveBeenCalled();

    const ready = harness.handlers.get(InterviewChannels.CaptureReady);
    await ready?.(senderEvent, { sessionId: result.sessionId });
    const lateMicrophonePermission = vi.fn();
    permissionHandler(harness.window.webContents, "media", lateMicrophonePermission, {
      isMainFrame: true,
      mediaTypes: ["audio"],
    });
    expect(lateMicrophonePermission).toHaveBeenCalledWith(false);
    const receiveFrame = harness.listeners.get(InterviewChannels.AudioFrame);
    receiveFrame?.(senderEvent, {
      sessionId: result.sessionId,
      source: "interviewer",
      sequence: 0,
      startSample: 0,
      sampleRate: 16_000,
      channels: 1,
      encoding: "pcm_s16le",
      pcm: new Uint8Array(3_200),
    });
    expect(agent.sendInterviewPcmFrame).not.toHaveBeenCalled();
    receiveFrame?.(senderEvent, {
      sessionId: result.sessionId,
      source: "candidate",
      sequence: 0,
      startSample: 0,
      sampleRate: 16_000,
      channels: 1,
      encoding: "pcm_s16le",
      pcm: new Uint8Array(3_200),
    });
    expect(agent.sendInterviewPcmFrame).toHaveBeenCalledOnce();
    harness.audioCreditListener?.({ sessionId: result.sessionId, count: 5 });
    expect(harness.window.webContents.send).toHaveBeenCalledWith(InterviewChannels.AudioCredit, {
      sessionId: result.sessionId,
      count: 5,
    });
    receiveFrame?.(senderEvent, {
      sessionId: result.sessionId,
      source: "interviewer",
      sequence: 1,
      startSample: 1_600,
      sampleRate: 16_000,
      channels: 1,
      encoding: "pcm_s16le",
      pcm: new Uint8Array(3_202),
    });
    expect(agent.sendInterviewPcmFrame).toHaveBeenCalledOnce();

    await ipc.stopActive();
    ipc.dispose();
  });
});

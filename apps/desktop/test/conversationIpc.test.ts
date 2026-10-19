import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: unknown[]) => unknown>,
  onChange: vi.fn(),
  send: vi.fn(),
  signedIn: true,
  modelSource: "cloud" as "local" | "cloud",
  mainWindow: { webContents: { id: "main" } },
  replyConversationId: "screenshot-01234567-89ab-4cde-8fab-0123456789ab",
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      shared.handlers[channel] = listener;
    },
    on: (channel: string, listener: (...args: unknown[]) => unknown) => {
      shared.handlers[channel] = listener;
    },
  },
}));

vi.mock("../src/main/window", () => ({
  getWindow: () => shared.mainWindow,
  isReplyBarWindowFromSender: (event: { sender: { id: string } }) => event.sender.id === "reply",
  isReplyBarConversationId: (conversationId: string) =>
    conversationId === shared.replyConversationId,
  isWindowFromSender: (
    window: { webContents: { id: string } },
    event: { sender: { id: string } },
  ) => window.webContents.id === event.sender.id,
  sendConversationChange: shared.send,
}));

import { AUTH_REQUIRED_CODE, ConversationChannels } from "@answra/shared";
import { registerConversationIpc } from "../src/main/conversation/conversationIpc";

const service = {
  getSnapshot: vi
    .fn()
    .mockResolvedValue({ conversationId: shared.replyConversationId, revision: 0, messages: [] }),
  readEvents: vi.fn().mockResolvedValue([]),
  send: vi.fn(),
  cancel: vi.fn(),
  onChange: shared.onChange,
};

const modelSettings = {
  getView: vi.fn().mockReturnValue({
    source: shared.modelSource,
    localAvailable: true,
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "local-model",
    answerModel: "",
    configured: true,
  }),
  save: vi.fn().mockResolvedValue({
    source: "local" as const,
    localAvailable: true,
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "local-model",
    answerModel: "",
    configured: true,
  }),
  clear: vi.fn().mockResolvedValue({
    source: "cloud" as const,
    localAvailable: true,
    baseUrl: "",
    model: "",
    answerModel: "",
    configured: false,
  }),
  revealApiKey: vi.fn().mockResolvedValue("secret-key"),
};

function canSend(): boolean {
  return shared.modelSource === "local" || shared.signedIn;
}

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const handler = shared.handlers[channel];
  if (!handler) throw new Error(`未注册 IPC handler: ${channel}`);
  return handler;
}

function register(): void {
  registerConversationIpc(service as never, { canSend, modelSettings });
}

describe("conversation IPC read access for reply renderer", () => {
  beforeEach(() => {
    shared.handlers = {};
    shared.onChange.mockClear();
    shared.send.mockClear();
    shared.signedIn = true;
    shared.modelSource = "cloud";
    service.getSnapshot.mockClear();
    service.readEvents.mockClear();
    service.send.mockClear();
    modelSettings.getView.mockClear();
    modelSettings.save.mockClear();
    modelSettings.clear.mockClear();
    modelSettings.revealApiKey.mockClear();
    register();
  });

  it("allows the reply renderer to read only the active conversation", async () => {
    const getSnapshot = getHandler(ConversationChannels.GetSnapshot);
    const readEvents = getHandler(ConversationChannels.ReadEvents);
    await expect(
      getSnapshot({ sender: { id: "reply" } }, { conversationId: shared.replyConversationId }),
    ).resolves.toMatchObject({
      revision: 0,
    });
    await expect(
      readEvents(
        { sender: { id: "reply" } },
        { conversationId: shared.replyConversationId, afterRevision: 0 },
      ),
    ).resolves.toEqual([]);
    await expect(() =>
      getSnapshot({ sender: { id: "reply" } }, { conversationId: "other-conversation" }),
    ).toThrow("非法调用方");
    await expect(() =>
      readEvents(
        { sender: { id: "reply" } },
        { conversationId: "other-conversation", afterRevision: 0 },
      ),
    ).toThrow("非法调用方");
  });

  it("keeps session creation and message sending restricted to the main renderer", async () => {
    await expect(() =>
      getHandler(ConversationChannels.Create)(
        { sender: { id: "reply" } },
        { conversationId: shared.replyConversationId },
      ),
    ).toThrow("非法调用方");
    expect(() =>
      getHandler(ConversationChannels.Send)(
        { sender: { id: "reply" } },
        { conversationId: shared.replyConversationId, request: { text: "x", images: [] } },
      ),
    ).toThrow("非法调用方");
    expect(service.send).not.toHaveBeenCalled();
  });

  it("forwards the service change subscription to the window broadcaster", () => {
    expect(shared.onChange).toHaveBeenCalledWith(shared.send);
  });

  it("rejects cloud model calls while signed out with the shared auth-required code", () => {
    shared.modelSource = "cloud";
    shared.signedIn = false;
    const send = getHandler(ConversationChannels.Send);
    const event = { sender: { id: "main" } };
    const answerRun = {
      operation: "answer.run",
      conversationId: "c-1",
      request: { text: "x", images: [] },
    };

    expect(() => send(event, answerRun)).toThrow(AUTH_REQUIRED_CODE);
    expect(() =>
      send(event, {
        operation: "chat.send",
        profileId: "general-chat",
        conversationId: "c-1",
        request: { text: "x", images: [] },
      }),
    ).toThrow(AUTH_REQUIRED_CODE);
    // 未登录在门禁处就被拦下：不让请求落到云端服务。
    expect(service.send).not.toHaveBeenCalled();
  });

  it("lets local model calls through without a login session", () => {
    shared.modelSource = "local";
    shared.signedIn = false;
    service.send.mockResolvedValue({ runId: "run-1" });

    expect(() =>
      getHandler(ConversationChannels.Send)(
        { sender: { id: "main" } },
        {
          operation: "answer.run",
          conversationId: "c-1",
          request: { text: "x", images: [] },
        },
      ),
    ).not.toThrow();
    expect(service.send).toHaveBeenCalledTimes(1);
  });

  it("still sends cloud model calls once the account is signed in", async () => {
    shared.modelSource = "cloud";
    shared.signedIn = true;
    service.send.mockResolvedValue({ runId: "run-1" });

    await expect(
      getHandler(ConversationChannels.Send)(
        { sender: { id: "main" } },
        {
          operation: "answer.run",
          conversationId: "c-1",
          request: { text: "x", images: [] },
        },
      ),
    ).resolves.toEqual({ runId: "run-1" });
    expect(service.send).toHaveBeenCalledTimes(1);
  });
});

describe("conversation IPC model settings", () => {
  beforeEach(() => {
    shared.handlers = {};
    shared.onChange.mockClear();
    shared.send.mockClear();
    shared.signedIn = true;
    shared.modelSource = "cloud";
    service.getSnapshot.mockClear();
    service.readEvents.mockClear();
    service.send.mockClear();
    modelSettings.getView.mockClear();
    modelSettings.save.mockClear();
    modelSettings.clear.mockClear();
    modelSettings.revealApiKey.mockClear();
    register();
  });

  it("returns the model settings view to the main renderer", async () => {
    await expect(
      getHandler(ConversationChannels.GetConfig)({ sender: { id: "main" } }),
    ).resolves.toMatchObject({ source: "cloud", configured: true });
    expect(modelSettings.getView).toHaveBeenCalledTimes(1);
  });

  it("rejects model settings reads from the reply renderer", async () => {
    await expect(
      getHandler(ConversationChannels.GetConfig)({ sender: { id: "reply" } }),
    ).rejects.toThrow("非法调用方");
    expect(modelSettings.getView).not.toHaveBeenCalled();
  });

  it("saves model settings through the port", async () => {
    const settings = {
      source: "local" as const,
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local-model",
      answerModel: "answer-model",
      apiKey: "new-key",
    };
    await expect(
      getHandler(ConversationChannels.Configure)({ sender: { id: "main" } }, settings),
    ).resolves.toMatchObject({ source: "local", configured: true });
    expect(modelSettings.save).toHaveBeenCalledWith(settings);
  });

  it("rejects model settings writes from the reply renderer", async () => {
    await expect(() =>
      getHandler(ConversationChannels.Configure)(
        { sender: { id: "reply" } },
        { source: "local", baseUrl: "http://x", model: "m" },
      ),
    ).toThrow("非法调用方");
    expect(modelSettings.save).not.toHaveBeenCalled();
  });

  it("reveals the saved api key only to the main renderer", async () => {
    await expect(
      getHandler(ConversationChannels.GetApiKey)({ sender: { id: "main" } }),
    ).resolves.toEqual({ apiKey: "secret-key" });
    expect(modelSettings.revealApiKey).toHaveBeenCalledTimes(1);
    await expect(
      getHandler(ConversationChannels.GetApiKey)({ sender: { id: "reply" } }),
    ).rejects.toThrow("非法调用方");
  });

  it("clears local model settings through the port", async () => {
    await expect(
      getHandler(ConversationChannels.ClearConfig)({ sender: { id: "main" } }),
    ).resolves.toMatchObject({ source: "cloud", configured: false });
    expect(modelSettings.clear).toHaveBeenCalledTimes(1);
    await expect(() =>
      getHandler(ConversationChannels.ClearConfig)({ sender: { id: "reply" } }),
    ).toThrow("非法调用方");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: unknown[]) => unknown>,
  onSessionFrame: vi.fn(),
  onLiveFrame: vi.fn(),
  onSnapshot: vi.fn(),
  send: vi.fn(),
  sendSnapshot: vi.fn(),
  sendFrame: vi.fn(),
  sendLiveFrame: vi.fn(),
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
  sendConversationSnapshot: shared.sendSnapshot,
  sendSessionFrame: shared.sendFrame,
  sendLiveFrame: shared.sendLiveFrame,
}));

import {
  ActiveChatConversationId,
  ActiveExamConversationId,
  AUTH_REQUIRED_CODE,
  ConversationChannels,
  MANUAL_COMPACTION_INSTRUCTIONS_MAX_CHARS,
} from "@answra/shared";
import { registerConversationIpc } from "../src/main/conversation/conversationIpc";

const service = {
  getSnapshot: vi
    .fn()
    .mockResolvedValue({ conversationId: shared.replyConversationId, revision: 0, messages: [] }),
  readFrames: vi.fn().mockResolvedValue([]),
  send: vi.fn(),
  cancelTurn: vi.fn(),
  clearConversation: vi.fn().mockResolvedValue(undefined),
  createConversation: vi.fn().mockResolvedValue(undefined),
  createAnswerConversation: vi.fn().mockResolvedValue(undefined),
  compactConversation: vi.fn().mockResolvedValue({
    result: { status: "compacted" },
    snapshot: {
      conversationId: ActiveChatConversationId,
      eventRevision: 1,
      lastSeq: 0,
      messages: [],
    },
  }),
  onSessionFrame: shared.onSessionFrame,
  onLiveFrame: shared.onLiveFrame,
  onSnapshot: shared.onSnapshot,
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
    shared.onSessionFrame.mockClear();
    shared.onLiveFrame.mockClear();
    shared.onSnapshot.mockClear();
    shared.send.mockClear();
    shared.sendSnapshot.mockClear();
    shared.sendFrame.mockClear();
    shared.sendLiveFrame.mockClear();
    shared.signedIn = true;
    shared.modelSource = "cloud";
    service.getSnapshot.mockClear();
    service.readFrames.mockClear();
    service.send.mockClear();
    service.clearConversation.mockClear();
    service.createConversation.mockClear();
    service.createAnswerConversation.mockClear();
    service.compactConversation.mockClear();
    modelSettings.getView.mockClear();
    modelSettings.save.mockClear();
    modelSettings.clear.mockClear();
    modelSettings.revealApiKey.mockClear();
    register();
  });

  it("passes one-shot compaction instructions and rejects overlong input", async () => {
    const compact = getHandler(ConversationChannels.Compact);
    await expect(
      compact(
        { sender: { id: "main" } },
        { conversationId: ActiveChatConversationId, instructions: "保留迁移决定" },
      ),
    ).resolves.toMatchObject({ result: { status: "compacted" } });
    expect(service.compactConversation).toHaveBeenCalledWith(
      ActiveChatConversationId,
      "保留迁移决定",
    );

    await expect(() =>
      compact(
        { sender: { id: "main" } },
        {
          conversationId: ActiveChatConversationId,
          instructions: "x".repeat(MANUAL_COMPACTION_INSTRUCTIONS_MAX_CHARS + 1),
        },
      ),
    ).toThrow("压缩指令无效或过长");
  });

  it("allows the reply renderer to read only the active conversation", async () => {
    const getSnapshot = getHandler(ConversationChannels.GetSnapshot);
    const readFrames = getHandler(ConversationChannels.ReadFrames);
    await expect(
      getSnapshot({ sender: { id: "reply" } }, { conversationId: shared.replyConversationId }),
    ).resolves.toMatchObject({
      revision: 0,
    });
    await expect(
      readFrames(
        { sender: { id: "reply" } },
        { conversationId: shared.replyConversationId, afterSeq: 0 },
      ),
    ).resolves.toEqual([]);
    await expect(() =>
      getSnapshot({ sender: { id: "reply" } }, { conversationId: "other-conversation" }),
    ).toThrow("非法调用方");
    await expect(() =>
      readFrames(
        { sender: { id: "reply" } },
        { conversationId: "other-conversation", afterSeq: 0 },
      ),
    ).toThrow("非法调用方");
  });

  it("rejects a frame cursor that is not a non-negative integer", async () => {
    const readFrames = getHandler(ConversationChannels.ReadFrames);
    expect(() =>
      readFrames(
        { sender: { id: "main" } },
        { conversationId: ActiveChatConversationId, afterSeq: -1 },
      ),
    ).toThrow("会话请求无效");
    expect(() =>
      readFrames(
        { sender: { id: "main" } },
        { conversationId: ActiveChatConversationId, afterSeq: 1.5 },
      ),
    ).toThrow("会话请求无效");
    expect(service.readFrames).not.toHaveBeenCalled();
  });

  it("forwards frames to the window broadcaster without merging them with events", async () => {
    const frame = {
      schemaVersion: 2 as const,
      sessionId: ActiveChatConversationId,
      seq: 1,
      eventId: "event-1",
      occurredAt: "2026-11-22T00:00:00.000Z",
      producerId: "test",
      event: {
        type: "turn-queued" as const,
        source: "user" as const,
        input: {
          id: "user-1",
          role: "user" as const,
          text: "hi",
          images: [],
          status: "complete" as const,
        },
        agentId: "general",
      },
    };
    const live = {
      sessionId: ActiveChatConversationId,
      messageId: "assistant-1",
      event: { type: "text-delta" as const, partId: "text-1", delta: "hi" },
    };
    service.onSessionFrame.mock.calls[0]?.[0](frame);
    service.onLiveFrame.mock.calls[0]?.[0](live);
    expect(shared.sendFrame).toHaveBeenCalledWith(frame);
    expect(shared.sendLiveFrame).toHaveBeenCalledWith(live);
  });

  it("lets the main renderer clear the current screenshot round", async () => {
    await expect(
      getHandler(ConversationChannels.ClearMessages)(
        { sender: { id: "main" } },
        { conversationId: shared.replyConversationId },
      ),
    ).resolves.toBeUndefined();
    expect(service.clearConversation).toHaveBeenCalledWith(shared.replyConversationId);

    await expect(() =>
      getHandler(ConversationChannels.ClearMessages)(
        { sender: { id: "reply" } },
        { conversationId: shared.replyConversationId },
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

  it("routes the one-shot answer conversation to the answer application", async () => {
    const create = getHandler(ConversationChannels.Create);
    await expect(
      create({ sender: { id: "main" } }, { conversationId: ActiveExamConversationId }),
    ).resolves.toBeUndefined();
    expect(service.createAnswerConversation).toHaveBeenCalledWith(ActiveExamConversationId);
    // 每轮截图使用新的一次性会话 id：必须同样走 answer 领域，不能以 conversation scope 落盘。
    await expect(
      create({ sender: { id: "main" } }, { conversationId: shared.replyConversationId }),
    ).resolves.toBeUndefined();
    expect(service.createAnswerConversation).toHaveBeenCalledWith(shared.replyConversationId);
    expect(service.createConversation).not.toHaveBeenCalled();
  });

  it("forwards the service change subscription to the window broadcaster", () => {
    expect(shared.onSessionFrame).toHaveBeenCalledWith(shared.sendFrame);
    expect(shared.onLiveFrame).toHaveBeenCalledWith(shared.sendLiveFrame);
    expect(shared.onSnapshot).toHaveBeenCalledWith(shared.sendSnapshot);
  });

  it("rejects cloud model calls while signed out with the shared auth-required code", () => {
    shared.modelSource = "cloud";
    shared.signedIn = false;
    const send = getHandler(ConversationChannels.Send);
    const event = { sender: { id: "main" } };
    const answerRun = {
      operation: "answer.send",
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
    service.send.mockResolvedValue({ turnId: "turn-1" });

    expect(() =>
      getHandler(ConversationChannels.Send)(
        { sender: { id: "main" } },
        {
          operation: "answer.send",
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
    service.send.mockResolvedValue({ turnId: "turn-1" });

    await expect(
      getHandler(ConversationChannels.Send)(
        { sender: { id: "main" } },
        {
          operation: "answer.send",
          conversationId: "c-1",
          request: { text: "x", images: [] },
        },
      ),
    ).resolves.toEqual({ turnId: "turn-1" });
    expect(service.send).toHaveBeenCalledTimes(1);
  });
});

describe("conversation IPC model settings", () => {
  beforeEach(() => {
    shared.handlers = {};
    shared.onSessionFrame.mockClear();
    shared.onLiveFrame.mockClear();
    shared.onSnapshot.mockClear();
    shared.send.mockClear();
    shared.sendSnapshot.mockClear();
    shared.sendFrame.mockClear();
    shared.sendLiveFrame.mockClear();
    shared.signedIn = true;
    shared.modelSource = "cloud";
    service.getSnapshot.mockClear();
    service.readFrames.mockClear();
    service.send.mockClear();
    service.clearConversation.mockClear();
    service.createConversation.mockClear();
    service.createAnswerConversation.mockClear();
    service.compactConversation.mockClear();
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

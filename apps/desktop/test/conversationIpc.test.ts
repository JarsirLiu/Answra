import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: unknown[]) => unknown>,
  onChange: vi.fn(),
  send: vi.fn(),
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

import { ConversationChannels } from "@answra/shared";
import { registerConversationIpc } from "../src/main/conversation/conversationIpc";

const service = {
  configure: vi.fn(),
  getApiKey: vi.fn(),
  getConfig: vi.fn(),
  getSnapshot: vi
    .fn()
    .mockResolvedValue({ conversationId: shared.replyConversationId, revision: 0, messages: [] }),
  readEvents: vi.fn().mockResolvedValue([]),
  send: vi.fn(),
  cancel: vi.fn(),
  onChange: shared.onChange,
};

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const handler = shared.handlers[channel];
  if (!handler) throw new Error(`未注册 IPC handler: ${channel}`);
  return handler;
}

describe("conversation IPC read access for reply renderer", () => {
  beforeEach(() => {
    shared.handlers = {};
    shared.onChange.mockClear();
    shared.send.mockClear();
    service.getSnapshot.mockClear();
    service.readEvents.mockClear();
    registerConversationIpc(service as never);
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
});

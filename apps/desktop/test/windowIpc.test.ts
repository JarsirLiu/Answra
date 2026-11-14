import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: unknown[]) => unknown>,
  quit: vi.fn(),
  setReplyBarWindowState: vi.fn(),
  resizeReplyBarWindow: vi.fn(),
  sendReplyBarAction: vi.fn(),
  sendReplyBarState: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { quit: shared.quit },
  ipcMain: {
    on: (channel: string, listener: (...args: unknown[]) => unknown) => {
      shared.handlers[channel] = listener;
    },
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      shared.handlers[channel] = listener;
    },
  },
}));

vi.mock("../src/main/window", () => ({
  applyStealth: vi.fn(),
  getWindow: () => ({ webContents: { id: "main" } }),
  isStealthSupported: () => true,
  isWindowFromSender: (_window: unknown, event: { sender: string }) => event.sender === "main",
  isReplyBarWindowFromSender: (event: { sender: string }) => event.sender === "reply",
  resizeReplyBarWindow: shared.resizeReplyBarWindow,
  resizeWindowToContent: vi.fn(),
  sendReplyBarAction: shared.sendReplyBarAction,
  sendReplyBarState: shared.sendReplyBarState,
  setReplyBarWindowState: shared.setReplyBarWindowState,
}));

import { WindowChannels } from "@answra/shared";
import { registerWindowIpc } from "../src/main/ipc/windowIpc";

const validState = {
  phase: "composing",
  attachments: [],
  draft: "question",
  replyText: "",
  replyActivities: [],
  stealth: true,
  theme: { variables: {} },
};

describe("detached reply window IPC", () => {
  beforeEach(() => {
    shared.handlers = {};
    shared.quit.mockClear();
    shared.setReplyBarWindowState.mockClear();
    shared.resizeReplyBarWindow.mockClear();
    shared.sendReplyBarAction.mockClear();
    shared.sendReplyBarState.mockClear();
    registerWindowIpc();
  });

  it("accepts workflow state only from the main renderer", () => {
    shared.handlers[WindowChannels.SetReplyBarState]({ sender: "main" }, validState);
    shared.handlers[WindowChannels.SetReplyBarState]({ sender: "reply" }, validState);
    shared.handlers[WindowChannels.SetReplyBarState](
      { sender: "main" },
      { ...validState, phase: "bad" },
    );
    shared.handlers[WindowChannels.SetReplyBarState](
      { sender: "main" },
      {
        ...validState,
        replyActivities: [{ id: "bad", kind: "unexpected", label: "bad", text: "bad" }],
      },
    );

    expect(shared.setReplyBarWindowState).toHaveBeenCalledTimes(1);
    expect(shared.setReplyBarWindowState).toHaveBeenCalledWith(validState);
  });

  it("accepts size and actions only from the reply renderer", () => {
    const size = { width: 480, height: 76 };
    const action = { type: "draft/change", value: "updated" };
    shared.handlers[WindowChannels.FitReplyBar]({ sender: "main" }, size);
    shared.handlers[WindowChannels.FitReplyBar]({ sender: "reply" }, size);
    shared.handlers[WindowChannels.ReplyBarAction]({ sender: "main" }, action);
    shared.handlers[WindowChannels.ReplyBarAction]({ sender: "reply" }, action);

    expect(shared.resizeReplyBarWindow).toHaveBeenCalledTimes(1);
    expect(shared.sendReplyBarAction).toHaveBeenCalledWith(action);
  });

  it("sends the latest state after the reply renderer confirms it subscribed", () => {
    shared.handlers[WindowChannels.ReplyBarReady]({ sender: "main" });
    shared.handlers[WindowChannels.ReplyBarReady]({ sender: "reply" });
    expect(shared.sendReplyBarState).toHaveBeenCalledOnce();
  });
});

describe("main window close IPC", () => {
  beforeEach(() => {
    shared.handlers = {};
    shared.quit.mockClear();
    registerWindowIpc();
  });

  it("quits the app instead of only closing the main window", () => {
    shared.handlers[WindowChannels.Close]({ sender: "main" });
    expect(shared.quit).toHaveBeenCalledOnce();
  });

  it("ignores close requests from other windows", () => {
    shared.handlers[WindowChannels.Close]({ sender: "reply" });
    expect(shared.quit).not.toHaveBeenCalled();
  });
});

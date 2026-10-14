import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: unknown[]) => unknown>,
  owner: { id: "main", webContents: { id: "main" } },
  candidate: { id: "candidate", webContents: { id: "candidate" } },
  setImeCandidateState: vi.fn(),
  resizeImeCandidateWindow: vi.fn(),
  sendImeCandidateAction: vi.fn(),
  sendImeCandidateState: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: (contents: { id: string }) =>
      contents.id === "main" ? shared.owner : contents.id === "candidate" ? shared.candidate : null,
  },
  ipcMain: {
    on: (channel: string, listener: (...args: unknown[]) => unknown) => {
      shared.handlers[channel] = listener;
    },
  },
}));

vi.mock("../src/main/window", () => ({
  getWindow: () => shared.owner,
  getReplyBarWindow: () => undefined,
  isImeCandidateWindowFromSender: (event: { sender: { id: string } }) =>
    event.sender.id === "candidate",
  isWindowFromSender: (window: { id: string }, event: { sender: { id: string } }) =>
    window.id === event.sender.id,
  resizeImeCandidateWindow: shared.resizeImeCandidateWindow,
  sendImeCandidateAction: shared.sendImeCandidateAction,
  sendImeCandidateState: shared.sendImeCandidateState,
  setImeCandidateState: shared.setImeCandidateState,
}));

import { ImeCandidateChannels, type ImeState } from "@answra/shared";
import { registerImeCandidateIpc } from "../src/main/ime/imeCandidateIpc";

const state: ImeState = {
  enabled: true,
  composing: true,
  preedit: "ni",
  candidates: [{ text: "你" }],
  selectedIndex: 0,
  page: 0,
  hasNextPage: false,
};

describe("IME candidate IPC", () => {
  beforeEach(() => {
    shared.handlers = {};
    shared.setImeCandidateState.mockClear();
    shared.resizeImeCandidateWindow.mockClear();
    shared.sendImeCandidateAction.mockClear();
    shared.sendImeCandidateState.mockClear();
    registerImeCandidateIpc();
  });

  it("accepts candidate geometry only from an owned input window", () => {
    const payload = { state, anchor: { x: 10, lineTop: 20, lineBottom: 40 } };
    shared.handlers[ImeCandidateChannels.Update]({ sender: { id: "main" } }, payload);
    shared.handlers[ImeCandidateChannels.Update]({ sender: { id: "other" } }, payload);
    shared.handlers[ImeCandidateChannels.Update](
      { sender: { id: "main" } },
      {
        ...payload,
        anchor: { ...payload.anchor, x: Number.NaN },
      },
    );

    expect(shared.setImeCandidateState).toHaveBeenCalledOnce();
    expect(shared.setImeCandidateState).toHaveBeenCalledWith(shared.owner, payload);
  });

  it("routes candidate actions only from the native candidate window", () => {
    const action = { type: "select", index: 0 };
    shared.handlers[ImeCandidateChannels.Action]({ sender: { id: "main" } }, action);
    shared.handlers[ImeCandidateChannels.Action]({ sender: { id: "candidate" } }, action);
    shared.handlers[ImeCandidateChannels.Ready]({ sender: { id: "candidate" } });
    shared.handlers[ImeCandidateChannels.Fit](
      { sender: { id: "candidate" } },
      {
        width: 360,
        height: 52,
      },
    );

    expect(shared.sendImeCandidateAction).toHaveBeenCalledWith(action);
    expect(shared.sendImeCandidateState).toHaveBeenCalledOnce();
    expect(shared.resizeImeCandidateWindow).toHaveBeenCalledWith({ width: 360, height: 52 });
  });
});

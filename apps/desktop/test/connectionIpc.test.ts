import type { AgentConnectionState } from "@answra/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: unknown[]) => unknown>,
  sendState: vi.fn(),
  onConnectionState: vi.fn(),
  mainWindow: { webContents: { id: "main" } },
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      shared.handlers[channel] = listener;
    },
  },
}));

vi.mock("../src/main/window", () => ({
  getWindow: () => shared.mainWindow,
  isReplyBarWindowFromSender: (event: { sender: { id: string } }) => event.sender.id === "reply",
  isWindowFromSender: (
    window: { webContents: { id: string } },
    event: { sender: { id: string } },
  ) => window.webContents.id === event.sender.id,
  sendConnectionState: shared.sendState,
}));

import { ConnectionChannels } from "@answra/shared";
import { registerConnectionIpc } from "../src/main/connection/connectionIpc";

const state: AgentConnectionState = {
  target: "agent-service",
  revision: 3,
  updatedAt: 1_000,
  status: "reconnecting",
  attempt: 2,
  maxAttempts: 5,
  nextRetryAt: 2_000,
  reason: "worker-exit",
};

const service = {
  getConnectionState: vi.fn(() => state),
  onConnectionState: shared.onConnectionState,
};

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const handler = shared.handlers[channel];
  if (!handler) throw new Error(`未注册 IPC handler: ${channel}`);
  return handler;
}

describe("connection IPC", () => {
  beforeEach(() => {
    shared.sendState.mockClear();
    shared.onConnectionState.mockClear();
    registerConnectionIpc(service as never);
  });

  it("returns the authoritative state to both app windows", () => {
    const handler = getHandler(ConnectionChannels.GetState);

    expect(handler({ sender: { id: "main" } })).toEqual(state);
    expect(handler({ sender: { id: "reply" } })).toEqual(state);
  });

  it("rejects senders outside the app windows", () => {
    const handler = getHandler(ConnectionChannels.GetState);

    expect(() => handler({ sender: { id: "other" } })).toThrow("非法调用方");
  });

  it("broadcasts every connection state change", () => {
    expect(shared.onConnectionState).toHaveBeenCalledTimes(1);
    const listener = shared.onConnectionState.mock.calls[0]?.[0] as (
      state: AgentConnectionState,
    ) => void;

    listener(state);

    expect(shared.sendState).toHaveBeenCalledWith(state);
  });
});

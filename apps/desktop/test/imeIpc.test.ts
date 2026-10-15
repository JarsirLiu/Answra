import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: unknown[]) => unknown>,
  main: { id: "main" },
  reply: { id: "reply" },
  bridge: {
    available: true,
    enable: vi.fn(async () => ({
      enabled: true,
      composing: false,
      preedit: "",
      candidates: [],
      selectedIndex: 0,
      page: 0,
      hasNextPage: false,
    })),
    key: vi.fn(async () => ({
      enabled: true,
      composing: true,
      preedit: "n",
      candidates: [],
      selectedIndex: 0,
      page: 0,
      hasNextPage: false,
    })),
    select: vi.fn(),
    reset: vi.fn(),
    dispose: vi.fn(),
  },
  setNativeImeEnabled: vi.fn(() => true),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      shared.handlers[channel] = listener;
    },
  },
}));

vi.mock("../src/main/window", () => ({
  getWindow: () => shared.main,
  getReplyBarWindow: () => shared.reply,
  isStealthEnabled: () => false,
  isWindowFromSender: (window: { id: string }, event: { sender: { id: string } }) =>
    window.id === event.sender.id,
}));

vi.mock("../src/main/windowStealthController", () => ({
  setNativeImeEnabled: shared.setNativeImeEnabled,
}));

vi.mock("../src/main/ime/rimeBridge", () => ({
  RimeBridge: class {
    available = shared.bridge.available;
    enable = shared.bridge.enable;
    key = shared.bridge.key;
    select = shared.bridge.select;
    reset = shared.bridge.reset;
    dispose = shared.bridge.dispose;
  },
}));

import { ImeChannels } from "@answra/shared";
import { registerImeIpc } from "../src/main/ime/imeIpc";

const emptyState = {
  enabled: false,
  composing: false,
  preedit: "",
  candidates: [],
  selectedIndex: 0,
  page: 0,
  hasNextPage: false,
};

function invoke(channel: string, senderId: string, payload?: unknown) {
  return shared.handlers[channel]({ sender: { id: senderId } }, payload);
}

describe("IME IPC session ownership", () => {
  beforeEach(() => {
    shared.handlers = {};
    shared.bridge.enable.mockClear();
    shared.bridge.key.mockClear();
    shared.bridge.select.mockClear();
    shared.bridge.reset.mockClear();
    shared.bridge.dispose.mockClear();
    shared.setNativeImeEnabled.mockClear();
    registerImeIpc();
  });

  it("routes a shared Rime session only through its latest owning window", async () => {
    await invoke(ImeChannels.Enable, "main", true);
    await invoke(ImeChannels.Enable, "reply", true);

    await expect(
      invoke(ImeChannels.Key, "main", {
        key: "n",
        code: "KeyN",
        shift: false,
        ctrl: false,
        alt: false,
        meta: false,
      }),
    ).resolves.toEqual(emptyState);
    await invoke(ImeChannels.Key, "reply", {
      key: "n",
      code: "KeyN",
      shift: false,
      ctrl: false,
      alt: false,
      meta: false,
    });

    expect(shared.bridge.enable).toHaveBeenCalledTimes(2);
    expect(shared.bridge.key).toHaveBeenCalledOnce();
    expect(shared.bridge.key).toHaveBeenCalledWith({
      key: "n",
      code: "KeyN",
      shift: false,
      ctrl: false,
      alt: false,
      meta: false,
    });
  });

  it("does not let invalid or non-owner calls disable the shared session", async () => {
    await invoke(ImeChannels.Enable, "main", true);
    await expect(invoke(ImeChannels.Enable, "untrusted", false)).resolves.toEqual(emptyState);
    expect(invoke(ImeChannels.Select, "reply", { index: 0 })).toEqual(emptyState);
    expect(invoke(ImeChannels.Reset, "untrusted")).toEqual(emptyState);

    expect(shared.bridge.enable).toHaveBeenCalledOnce();
    expect(shared.bridge.enable).toHaveBeenCalledWith(true);
    expect(shared.bridge.select).not.toHaveBeenCalled();
    expect(shared.bridge.reset).not.toHaveBeenCalled();
  });
});

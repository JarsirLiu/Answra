import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: unknown[]) => unknown>,
  listeners: {} as Record<string, (...args: unknown[]) => unknown>,
  main: {
    id: 1,
    isDestroyed: () => false,
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    webContents: { id: 11, on: vi.fn(), removeListener: vi.fn() },
  },
  reply: {
    id: 2,
    isDestroyed: () => false,
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    webContents: { id: 22, on: vi.fn(), removeListener: vi.fn() },
  },
  candidate: {
    id: 3,
    isDestroyed: () => false,
    webContents: { id: 33, on: vi.fn(), removeListener: vi.fn() },
  },
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
  BrowserWindow: {
    getFocusedWindow: () => shared.main,
    fromWebContents: (contents: { id: number }) =>
      contents.id === shared.candidate.webContents.id ? shared.candidate : undefined,
  },
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      shared.handlers[channel] = listener;
    },
    on: (channel: string, listener: (...args: unknown[]) => unknown) => {
      shared.listeners[channel] = listener;
    },
    removeListener: vi.fn(),
  },
}));

vi.mock("../src/main/window", () => ({
  getWindow: () => shared.main,
  getReplyBarWindow: () => shared.reply,
  isStealthEnabled: () => false,
  isImeCandidateWindowFromSender: (event: { sender: { id: number } }) => event.sender.id === 33,
  setImeCandidateState: vi.fn(),
  isWindowFromSender: (
    window: { webContents: { id: number } },
    event: { sender: { id: number } },
  ) => window.webContents.id === event.sender.id,
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

vi.mock("../src/main/ime/imeDiagnostics", () => ({
  logImeDiagnostic: vi.fn(),
}));

import { ImeChannels } from "@answra/shared";
import { logImeDiagnostic } from "../src/main/ime/imeDiagnostics";
import { registerImeIpc } from "../src/main/ime/imeIpc";

const emptyState = {
  enabled: false,
  composing: false,
  preedit: "",
  candidates: [],
  selectedIndex: 0,
  page: 0,
  hasNextPage: false,
  handled: false,
};

function invoke(channel: string, senderId: number, payload?: unknown) {
  return shared.handlers[channel]({ sender: { id: senderId } }, payload);
}

describe("IME IPC session ownership", () => {
  beforeEach(() => {
    shared.handlers = {};
    shared.listeners = {};
    shared.bridge.enable.mockClear();
    shared.bridge.key.mockClear();
    shared.bridge.select.mockClear();
    shared.bridge.reset.mockClear();
    shared.bridge.dispose.mockClear();
    shared.setNativeImeEnabled.mockClear();
    registerImeIpc();
  });

  it("routes a shared Rime session only through its latest owning lease", async () => {
    const mainLease = (await invoke(ImeChannels.Acquire, 11, { targetId: "main-composer" })) as {
      generation: number;
    };
    const replyLease = (await invoke(ImeChannels.Acquire, 22, { targetId: "reply-composer" })) as {
      generation: number;
    };

    await expect(
      invoke(ImeChannels.Key, 11, {
        generation: mainLease.generation,
        key: "n",
        code: "KeyN",
        shift: false,
        ctrl: false,
        alt: false,
        meta: false,
      }),
    ).resolves.toEqual(emptyState);
    await invoke(ImeChannels.Key, 22, {
      generation: replyLease.generation,
      key: "n",
      code: "KeyN",
      shift: false,
      ctrl: false,
      alt: false,
      meta: false,
    });

    expect(shared.bridge.enable).toHaveBeenCalledTimes(4);
    expect(shared.bridge.key).toHaveBeenCalledOnce();
    expect(shared.bridge.key).toHaveBeenCalledWith({
      generation: replyLease.generation,
      key: "n",
      code: "KeyN",
      shift: false,
      ctrl: false,
      alt: false,
      meta: false,
    });
  });

  it("rejects stale and non-owner lease operations", async () => {
    const lease = (await invoke(ImeChannels.Acquire, 11, { targetId: "main-composer" })) as {
      generation: number;
    };
    const replyLease = (await invoke(ImeChannels.Acquire, 22, { targetId: "reply-composer" })) as {
      generation: number;
    };
    await expect(
      invoke(ImeChannels.Release, 11, { generation: lease.generation }),
    ).resolves.toMatchObject({ accepted: false });
    await expect(
      invoke(ImeChannels.Select, 11, { index: 0, generation: replyLease.generation }),
    ).resolves.toEqual(emptyState);
    await expect(
      invoke(ImeChannels.Reset, 99, { generation: replyLease.generation }),
    ).resolves.toEqual(emptyState);

    expect(shared.bridge.enable).toHaveBeenCalledTimes(4);
    expect(shared.bridge.select).not.toHaveBeenCalled();
    expect(shared.bridge.reset).toHaveBeenCalledTimes(2);
  });

  it("forwards whitelisted focus diagnostics while suppressing key-routing noise", () => {
    vi.mocked(logImeDiagnostic).mockClear();
    const report = shared.listeners[ImeChannels.Diagnostic];
    report(
      { sender: { id: 11 } },
      {
        event: "key-routing",
        targetId: "main-composer",
        source: "must-not-be-logged",
        activeElementTarget: false,
        documentHasFocus: true,
        focusedRef: false,
        accepted: false,
        key: "n",
        keyCode: "KeyN",
        keyKind: "text",
        typedText: "must-not-be-logged",
      },
    );
    report(
      { sender: { id: 11 } },
      {
        event: "input-focus",
        targetId: "main-composer",
        activeElementTarget: true,
        documentHasFocus: true,
        focusedRef: true,
        imeAvailable: true,
        imeEnabled: true,
        typedText: "must-not-be-logged",
      },
    );
    report({ sender: { id: 99 } }, { event: "input-focus", targetId: "main-composer" });
    report(
      { sender: { id: 11 } },
      {
        event: "input-focus",
        targetId: "sensitive-user-text",
      },
    );

    expect(logImeDiagnostic).toHaveBeenCalledTimes(1);
    expect(logImeDiagnostic).toHaveBeenCalledWith("renderer-input-focus", {
      windowId: 1,
      webContentsId: 11,
      targetId: "main-composer",
      activeElementTarget: true,
      documentHasFocus: true,
      focusedRef: true,
      imeAvailable: true,
      imeEnabled: true,
    });
  });

  it("forwards shortcut routing with selection metadata but no editor contents", () => {
    vi.mocked(logImeDiagnostic).mockClear();
    const report = shared.listeners[ImeChannels.Diagnostic];
    report(
      { sender: { id: 11 } },
      {
        event: "key-routing",
        targetId: "main-composer",
        key: "a",
        keyCode: "KeyA",
        keyKind: "text",
        ctrl: true,
        composing: true,
        accepted: true,
        selectionStart: 0,
        selectionEnd: 13,
        selectionLength: 13,
        valueLength: 13,
        editorContents: "must-not-be-logged",
      },
    );

    expect(logImeDiagnostic).toHaveBeenCalledWith("key-routing", {
      windowId: 1,
      webContentsId: 11,
      targetId: "main-composer",
      key: "a",
      keyCode: "KeyA",
      keyKind: "text",
      selectionStart: 0,
      selectionEnd: 13,
      selectionLength: 13,
      valueLength: 13,
      composing: true,
      accepted: true,
      ctrl: true,
    });
  });

  it("records candidate DOM render diagnostics only from the candidate window", () => {
    vi.mocked(logImeDiagnostic).mockClear();
    const report = shared.listeners[ImeChannels.Diagnostic];
    report(
      { sender: { id: 33 } },
      {
        event: "candidate-rendered",
        targetId: "ime-candidate-window",
        ownerTargetId: "chat-composer",
        generation: 4,
        preedit: "ni",
        candidates: [{ text: "你", comment: "代词" }],
        documentVisibility: "visible",
        candidateRoot: { rect: { x: 0, y: 0, width: 392, height: 60 } },
      },
    );

    expect(logImeDiagnostic).toHaveBeenCalledWith("candidate-rendered", {
      windowId: 3,
      webContentsId: 33,
      targetId: "ime-candidate-window",
      ownerTargetId: "chat-composer",
      generation: 4,
      preedit: "ni",
      candidates: [{ text: "你", comment: "代词" }],
      documentVisibility: "visible",
      candidateRoot: { rect: { x: 0, y: 0, width: 392, height: 60 } },
      candidatePopup: undefined,
    });
  });
});

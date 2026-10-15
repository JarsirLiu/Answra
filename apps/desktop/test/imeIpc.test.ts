import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: unknown[]) => unknown>,
  listeners: {} as Record<string, (...args: unknown[]) => unknown>,
  focusSubscribers: new Set<
    (event: { window: unknown; focused: boolean; visible: boolean }) => void
  >(),
  focusedWindow: undefined as unknown,
  appForeground: true,
  setImeCandidateState: vi.fn(),
  main: {
    id: 1,
    isDestroyed: () => false,
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    webContents: { id: 11, on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
  },
  reply: {
    id: 2,
    isDestroyed: () => false,
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    webContents: { id: 22, on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
  },
  candidate: {
    id: 3,
    isDestroyed: () => false,
    webContents: { id: 33, on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
  },
  bridge: {
    available: true,
    snapshot: {
      enabled: false,
      inputMode: "chinese" as const,
      composing: false,
      preedit: "",
      candidates: [],
      selectedIndex: 0,
      page: 0,
      hasNextPage: false,
    },
    enable: vi.fn(async (enabled: boolean) => {
      shared.bridge.snapshot = { ...shared.bridge.snapshot, enabled };
      return shared.bridge.snapshot;
    }),
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
    setInputMode: vi.fn(async (inputMode: "chinese" | "ascii") => ({
      enabled: true,
      inputMode,
      composing: false,
      preedit: "",
      candidates: [],
      selectedIndex: 0,
      page: 0,
      hasNextPage: false,
    })),
    reset: vi.fn(async () => {
      shared.bridge.snapshot = {
        ...shared.bridge.snapshot,
        composing: false,
        preedit: "",
        candidates: [],
        selectedIndex: 0,
      };
      return shared.bridge.snapshot;
    }),
    dispose: vi.fn(),
  },
  setNativeImeEnabled: vi.fn(() => true),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getFocusedWindow: () => shared.focusedWindow,
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
  setImeCandidateState: shared.setImeCandidateState,
  subscribeToWindowFocus: (
    listener: (event: { window: unknown; focused: boolean; visible: boolean }) => void,
  ) => {
    shared.focusSubscribers.add(listener);
    return () => shared.focusSubscribers.delete(listener);
  },
  isWindowFromSender: (
    window: { webContents: { id: number } },
    event: { sender: { id: number } },
  ) => window.webContents.id === event.sender.id,
}));

vi.mock("../src/main/windowStealthController", () => ({
  setNativeImeEnabled: shared.setNativeImeEnabled,
}));

vi.mock("../src/main/windowForeground", () => ({
  isCurrentProcessForeground: () => shared.appForeground,
}));

vi.mock("../src/main/ime/rimeBridge", () => ({
  RimeBridge: class {
    available = shared.bridge.available;
    get snapshot() {
      return shared.bridge.snapshot;
    }
    enable = shared.bridge.enable;
    key = shared.bridge.key;
    select = shared.bridge.select;
    setInputMode = shared.bridge.setInputMode;
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
  inputMode: "chinese",
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
    shared.focusSubscribers.clear();
    shared.focusedWindow = shared.main;
    shared.appForeground = true;
    shared.bridge.snapshot = { ...emptyState };
    shared.bridge.enable.mockClear();
    shared.bridge.key.mockClear();
    shared.bridge.select.mockClear();
    shared.bridge.setInputMode.mockClear();
    shared.bridge.reset.mockClear();
    shared.bridge.dispose.mockClear();
    shared.setNativeImeEnabled.mockClear();
    shared.setImeCandidateState.mockClear();
    shared.main.webContents.send.mockClear();
    shared.reply.webContents.send.mockClear();
    registerImeIpc();
  });

  it("serves and broadcasts authoritative snapshots through the typed session API", async () => {
    const result = (await invoke(ImeChannels.SessionCommand, 11, {
      type: "acquireTarget",
      commandId: "acquire-1",
      targetId: "main-composer",
    })) as { accepted: boolean; snapshot: { phase: string; owner?: { targetId: string } } };

    expect(result).toMatchObject({
      accepted: true,
      snapshot: { phase: "owned", owner: { targetId: "main-composer" } },
    });
    expect(shared.main.webContents.send).toHaveBeenCalledWith(
      ImeChannels.SessionSnapshot,
      expect.objectContaining({ snapshot: expect.objectContaining({ phase: "owned" }) }),
    );
    await expect(invoke(ImeChannels.SessionSnapshot, 11)).resolves.toMatchObject({
      snapshot: { phase: "owned", owner: { targetId: "main-composer" } },
    });
    const unauthorized = (await invoke(ImeChannels.SessionSnapshot, 99)) as {
      snapshot: Record<string, unknown>;
    };
    expect(unauthorized.snapshot.phase).toBe("idle");
    expect(unauthorized.snapshot).not.toHaveProperty("owner");
  });

  it("rejects stale revisions and deduplicates repeated command IDs", async () => {
    const lease = (await invoke(ImeChannels.SessionCommand, 11, {
      type: "acquireTarget",
      commandId: "acquire-1",
      targetId: "main-composer",
    })) as { snapshot: { owner: { generation: number }; revision: number } };
    const generation = lease.snapshot.owner.generation;
    const before = shared.bridge.key.mock.calls.length;

    await expect(
      invoke(ImeChannels.SessionCommand, 11, {
        type: "processKey",
        commandId: "stale-key",
        expectedRevision: lease.snapshot.revision - 1,
        targetId: "main-composer",
        generation,
        key: "n",
        code: "KeyN",
        shift: false,
        ctrl: false,
        alt: false,
        meta: false,
      }),
    ).resolves.toMatchObject({ accepted: false, reason: "stale-revision" });
    expect(shared.bridge.key).toHaveBeenCalledTimes(before);

    const command = {
      type: "setInputMode",
      commandId: "mode-1",
      targetId: "main-composer",
      generation,
      inputMode: "ascii",
    };
    const first = await invoke(ImeChannels.SessionCommand, 11, command);
    const calls = shared.bridge.setInputMode.mock.calls.length;
    const repeated = await invoke(ImeChannels.SessionCommand, 11, command);

    expect(repeated).toEqual(first);
    expect(shared.bridge.setInputMode).toHaveBeenCalledTimes(calls);
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

    expect(shared.bridge.enable).toHaveBeenCalledOnce();
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

    expect(shared.bridge.enable).toHaveBeenCalledOnce();
    expect(shared.bridge.select).not.toHaveBeenCalled();
    expect(shared.bridge.reset).not.toHaveBeenCalled();
  });

  it("sets the authoritative mode for the current target without resetting composition", async () => {
    const lease = (await invoke(ImeChannels.Acquire, 11, { targetId: "main-composer" })) as {
      generation: number;
    };
    shared.bridge.reset.mockClear();
    shared.bridge.setInputMode.mockResolvedValue({
      enabled: true,
      inputMode: "ascii",
      composing: true,
      preedit: "ni",
      candidates: [{ text: "你" }],
      selectedIndex: 0,
      page: 0,
      hasNextPage: false,
    });

    const result = await invoke(ImeChannels.SetInputMode, 11, {
      targetId: "main-composer",
      generation: lease.generation,
      inputMode: "ascii",
    });

    expect(result).toMatchObject({ inputMode: "ascii", composing: true, preedit: "ni" });
    expect(shared.bridge.setInputMode).toHaveBeenCalledWith("ascii");
    expect(shared.bridge.reset).not.toHaveBeenCalled();
  });

  it("keeps the engine enabled and preserves its mode when a lease is released", async () => {
    const lease = (await invoke(ImeChannels.Acquire, 11, { targetId: "main-composer" })) as {
      generation: number;
    };
    shared.bridge.snapshot = { ...emptyState, enabled: true, inputMode: "ascii" };

    const released = await invoke(ImeChannels.Release, 11, { generation: lease.generation });

    expect(released).toMatchObject({
      accepted: true,
      state: { enabled: true, inputMode: "ascii" },
    });
    expect(shared.bridge.enable).toHaveBeenCalledOnce();
    expect(shared.bridge.reset).not.toHaveBeenCalled();
  });

  it("cancels the previous target composition on transfer while retaining engine mode", async () => {
    const first = (await invoke(ImeChannels.Acquire, 11, { targetId: "main-composer" })) as {
      generation: number;
    };
    shared.bridge.snapshot = { ...emptyState, enabled: true, inputMode: "ascii", composing: true };

    const second = await invoke(ImeChannels.Acquire, 22, { targetId: "reply-composer" });

    expect(shared.bridge.reset).toHaveBeenCalledOnce();
    expect(shared.bridge.enable).toHaveBeenCalledOnce();
    expect(second).toMatchObject({
      accepted: true,
      targetId: "reply-composer",
      generation: first.generation + 1,
      state: { enabled: true, inputMode: "ascii" },
    });
  });

  it("suspends the lease from the shared native focus stream after an app switch", async () => {
    const lease = (await invoke(ImeChannels.Acquire, 11, { targetId: "main-composer" })) as {
      generation: number;
    };
    vi.useFakeTimers();
    shared.focusedWindow = undefined;
    shared.appForeground = false;
    for (const listener of shared.focusSubscribers)
      listener({ window: shared.main, focused: false, visible: true });

    await vi.advanceTimersByTimeAsync(120);

    expect(logImeDiagnostic).toHaveBeenCalledWith(
      "lease-suspended",
      expect.objectContaining({ windowId: 1, generation: lease.generation }),
    );
    expect(shared.setNativeImeEnabled).toHaveBeenCalledWith(shared.main, false);
    expect(shared.setImeCandidateState).toHaveBeenCalledWith(shared.main, {
      type: "suspend",
      targetId: "main-composer",
      generation: lease.generation,
    });
    vi.useRealTimers();
  });

  it("reapplies native IME isolation when the owning window regains focus", async () => {
    await invoke(ImeChannels.Acquire, 11, { targetId: "main-composer" });
    shared.setNativeImeEnabled.mockClear();

    for (const listener of shared.focusSubscribers)
      listener({ window: shared.main, focused: true, visible: true });

    expect(shared.setNativeImeEnabled).toHaveBeenCalledOnce();
    expect(shared.setNativeImeEnabled).toHaveBeenCalledWith(shared.main, false);
  });

  it("suspends the lease if native IME isolation fails after focus returns", async () => {
    const lease = (await invoke(ImeChannels.Acquire, 11, { targetId: "main-composer" })) as {
      generation: number;
    };
    shared.setNativeImeEnabled.mockReturnValue(false);

    for (const listener of shared.focusSubscribers)
      listener({ window: shared.main, focused: true, visible: true });

    expect(shared.setImeCandidateState).toHaveBeenCalledWith(shared.main, {
      type: "suspend",
      targetId: "main-composer",
      generation: lease.generation,
    });
    expect(logImeDiagnostic).toHaveBeenCalledWith("native-ime-isolation-failed-on-focus", {
      windowId: shared.main.id,
      generation: lease.generation,
    });
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

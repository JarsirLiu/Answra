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
    webContents: {
      id: 11,
      on: vi.fn(),
      removeListener: vi.fn(),
      send: vi.fn(),
      isDestroyed: () => false,
    },
  },
  reply: {
    id: 2,
    isDestroyed: () => false,
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    webContents: {
      id: 22,
      on: vi.fn(),
      removeListener: vi.fn(),
      send: vi.fn(),
      isDestroyed: () => false,
    },
  },
  candidate: {
    id: 3,
    isDestroyed: () => false,
    webContents: {
      id: 33,
      on: vi.fn(),
      removeListener: vi.fn(),
      send: vi.fn(),
      isDestroyed: () => false,
    },
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
    key: vi.fn(async (request: { key: string; release?: boolean }) => {
      const current = shared.bridge.snapshot;
      const next =
        request.key === "Shift"
          ? request.release
            ? {
                ...current,
                inputMode:
                  current.inputMode === "ascii" ? ("chinese" as const) : ("ascii" as const),
                candidates: current.inputMode === "ascii" ? current.candidates : [],
              }
            : current
          : {
              ...current,
              enabled: true,
              composing: true,
              preedit: "n",
              candidates: [],
            };
      shared.bridge.snapshot = next;
      return { ...next, handled: request.key !== "Shift" };
    }),
    select: vi.fn(),
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
  isolateNativeIme: vi.fn(() => "applied"),
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
  isolateNativeIme: shared.isolateNativeIme,
}));

vi.mock("../src/main/windowForeground", () => ({
  isCurrentProcessForeground: () => shared.appForeground,
  describeForegroundWindow: () => ({}),
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
    reset = shared.bridge.reset;
    dispose = shared.bridge.dispose;
  },
}));

vi.mock("../src/main/ime/imeDiagnostics", () => ({
  logImeDiagnostic: vi.fn(),
  isImeDebugEnabled: () => false,
}));

import { ImeChannels, type ImeSessionCommandResult } from "@answra/shared";
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

let commandSequence = 0;
function nextCommandId(prefix: string): string {
  commandSequence += 1;
  return `${prefix}-${commandSequence}`;
}

/** Acquires a lease through the single session entry point. */
async function acquire(senderId: number, targetId: string): Promise<ImeSessionCommandResult> {
  return (await invoke(ImeChannels.SessionCommand, senderId, {
    type: "acquireTarget",
    commandId: nextCommandId("acquire"),
    targetId,
  })) as ImeSessionCommandResult;
}

/** Reads the owning lease generation out of a session result. */
function leaseGeneration(result: ImeSessionCommandResult): number {
  const owner = result.snapshot.owner;
  if (!owner) throw new Error("expected the session result to own the target");
  return owner.generation;
}

/** Mirrors Electron: a destroyed window throws when `webContents` is read. */
function destroyMainWindow(): () => void {
  const contents = shared.main.webContents;
  contents.isDestroyed = () => true;
  Object.defineProperty(shared.main, "webContents", {
    configurable: true,
    get() {
      throw new TypeError("Object has been destroyed");
    },
  });
  return () => {
    contents.isDestroyed = () => false;
    Object.defineProperty(shared.main, "webContents", { configurable: true, value: contents });
  };
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
    shared.bridge.reset.mockClear();
    shared.bridge.dispose.mockClear();
    shared.isolateNativeIme.mockClear();
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

  it("keeps the existing lease path when no native isolation API applies", async () => {
    shared.isolateNativeIme.mockReturnValueOnce("not-required");

    await expect(
      invoke(ImeChannels.SessionCommand, 11, {
        type: "acquireTarget",
        commandId: "acquire-without-native-isolation",
        targetId: "main-composer",
      }),
    ).resolves.toMatchObject({
      accepted: true,
      snapshot: { phase: "owned", owner: { targetId: "main-composer" } },
    });
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
      type: "processKey",
      commandId: "shift-up-1",
      targetId: "main-composer",
      generation,
      key: "Shift",
      code: "ShiftLeft",
      shift: false,
      ctrl: false,
      alt: false,
      meta: false,
      release: true,
    };
    const first = await invoke(ImeChannels.SessionCommand, 11, command);
    const calls = shared.bridge.key.mock.calls.length;
    const repeated = await invoke(ImeChannels.SessionCommand, 11, command);

    expect(repeated).toEqual(first);
    expect(shared.bridge.key).toHaveBeenCalledTimes(calls);

    const conflict = await invoke(ImeChannels.SessionCommand, 11, {
      ...command,
      code: "ShiftRight",
    });
    expect(conflict).toMatchObject({
      accepted: false,
      reason: "command-id-conflict",
    });
    expect(shared.bridge.key).toHaveBeenCalledTimes(calls);
  });

  it("routes a shared Rime session only through its latest owning lease", async () => {
    const mainLease = leaseGeneration(await acquire(11, "main-composer"));
    const replyLease = leaseGeneration(await acquire(22, "reply-composer"));

    await expect(
      invoke(ImeChannels.SessionCommand, 11, {
        type: "processKey",
        commandId: "stale-owner-key",
        targetId: "main-composer",
        generation: mainLease,
        key: "n",
        code: "KeyN",
        shift: false,
        ctrl: false,
        alt: false,
        meta: false,
      }),
    ).resolves.toMatchObject({ accepted: false, reason: "stale-owner" });
    await invoke(ImeChannels.SessionCommand, 22, {
      type: "processKey",
      commandId: "owned-key",
      targetId: "reply-composer",
      generation: replyLease,
      key: "n",
      code: "KeyN",
      shift: false,
      ctrl: false,
      alt: false,
      meta: false,
    });

    expect(shared.bridge.enable).toHaveBeenCalledOnce();
    expect(shared.bridge.key).toHaveBeenCalledOnce();
    expect(shared.bridge.key).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: replyLease,
        key: "n",
        code: "KeyN",
        shift: false,
        ctrl: false,
        alt: false,
        meta: false,
      }),
    );
  });

  it("rejects stale and non-owner lease operations", async () => {
    const generation = leaseGeneration(await acquire(11, "main-composer"));
    const replyGeneration = leaseGeneration(await acquire(22, "reply-composer"));
    await expect(
      invoke(ImeChannels.SessionCommand, 11, {
        type: "releaseTarget",
        commandId: "stale-release",
        targetId: "main-composer",
        generation,
      }),
    ).resolves.toMatchObject({ accepted: false });
    await expect(
      invoke(ImeChannels.SessionCommand, 11, {
        type: "selectCandidate",
        commandId: "non-owner-select",
        targetId: "reply-composer",
        generation: replyGeneration,
        index: 0,
      }),
    ).resolves.toMatchObject({ accepted: false, reason: "stale-owner" });
    await expect(
      invoke(ImeChannels.SessionCommand, 99, {
        type: "cancelComposition",
        commandId: "unknown-sender-reset",
        targetId: "reply-composer",
        generation: replyGeneration,
      }),
    ).resolves.toMatchObject({ accepted: false, reason: "stale-owner" });

    expect(shared.bridge.enable).toHaveBeenCalledOnce();
    expect(shared.bridge.select).not.toHaveBeenCalled();
    expect(shared.bridge.reset).not.toHaveBeenCalled();
  });

  it("sends physical Shift edges to the engine and publishes its authoritative state", async () => {
    const generation = leaseGeneration(await acquire(11, "main-composer"));
    shared.bridge.reset.mockClear();
    shared.bridge.snapshot = {
      enabled: true,
      inputMode: "chinese",
      composing: true,
      preedit: "ni",
      candidates: [{ text: "你" }],
      selectedIndex: 0,
      page: 0,
      hasNextPage: false,
    };

    await invoke(ImeChannels.SessionCommand, 11, {
      type: "processKey",
      commandId: "shift-down",
      targetId: "main-composer",
      generation,
      key: "Shift",
      code: "ShiftLeft",
      shift: true,
      ctrl: false,
      alt: false,
      meta: false,
    });
    const result = (await invoke(ImeChannels.SessionCommand, 11, {
      type: "processKey",
      commandId: "shift-up",
      targetId: "main-composer",
      generation,
      key: "Shift",
      code: "ShiftLeft",
      shift: false,
      ctrl: false,
      alt: false,
      meta: false,
      release: true,
    })) as { engineHandled?: boolean; snapshot: { engine: Record<string, unknown> } };

    expect(result.snapshot.engine).toMatchObject({
      inputMode: "ascii",
      composing: true,
      preedit: "ni",
      candidates: [],
    });
    expect(result.engineHandled).toBe(false);
    expect(shared.bridge.key).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ key: "Shift", code: "ShiftLeft", shift: true }),
    );
    expect(shared.bridge.key).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ key: "Shift", code: "ShiftLeft", release: true }),
    );
    expect(shared.bridge.reset).not.toHaveBeenCalled();
  });

  it("keeps the engine enabled and preserves its mode when a lease is released", async () => {
    const generation = leaseGeneration(await acquire(11, "main-composer"));
    shared.bridge.snapshot = { ...emptyState, enabled: true, inputMode: "ascii" };

    const released = await invoke(ImeChannels.SessionCommand, 11, {
      type: "releaseTarget",
      commandId: "release-keeps-mode",
      targetId: "main-composer",
      generation,
    });

    expect(released).toMatchObject({
      accepted: true,
      snapshot: { engine: { enabled: true, inputMode: "ascii" } },
    });
    expect(shared.bridge.enable).toHaveBeenCalledOnce();
    expect(shared.bridge.reset).not.toHaveBeenCalled();
  });

  it("records why the renderer released a lease", async () => {
    vi.mocked(logImeDiagnostic).mockClear();
    const generation = leaseGeneration(await acquire(11, "main-composer"));

    await invoke(ImeChannels.SessionCommand, 11, {
      type: "releaseTarget",
      commandId: "release-reason",
      targetId: "main-composer",
      generation,
      reason: "target-switched",
    });

    expect(logImeDiagnostic).toHaveBeenCalledWith("lease-released", {
      windowId: 1,
      targetId: "main-composer",
      generation,
      reason: "target-switched",
      composing: false,
    });
  });

  it("never echoes an unvalidated release reason into the log", async () => {
    vi.mocked(logImeDiagnostic).mockClear();
    const generation = leaseGeneration(await acquire(11, "main-composer"));

    await invoke(ImeChannels.SessionCommand, 11, {
      type: "releaseTarget",
      commandId: "release-unvalidated-reason",
      targetId: "main-composer",
      generation,
      reason: "用户输入的内容",
    });

    expect(logImeDiagnostic).toHaveBeenCalledWith(
      "lease-released",
      expect.objectContaining({ reason: "renderer-unspecified" }),
    );
  });

  it("records why an owned lease ended when the owner window closes", async () => {
    const generation = leaseGeneration(await acquire(11, "main-composer"));
    vi.mocked(logImeDiagnostic).mockClear();

    const onClosed = shared.main.once.mock.calls.find(([event]) => event === "closed")?.[1] as
      | (() => void)
      | undefined;
    onClosed?.();

    expect(logImeDiagnostic).toHaveBeenCalledWith("lease-released", {
      windowId: 1,
      targetId: "main-composer",
      generation,
      reason: "owner-window-closed",
      staleListener: false,
    });
  });

  it("survives detaching lease listeners after the owner window is destroyed", async () => {
    const generation = leaseGeneration(await acquire(11, "main-composer"));
    vi.mocked(logImeDiagnostic).mockClear();
    const onClosed = shared.main.once.mock.calls.find(([event]) => event === "closed")?.[1] as
      | (() => void)
      | undefined;
    const restore = destroyMainWindow();

    try {
      expect(() => onClosed?.()).not.toThrow();
    } finally {
      restore();
    }

    expect(logImeDiagnostic).toHaveBeenCalledWith("lease-released", {
      windowId: 1,
      targetId: "main-composer",
      generation,
      reason: "owner-window-closed",
      staleListener: false,
    });
  });

  it("disposes without touching a destroyed owner window", async () => {
    await acquire(11, "main-composer");
    const controller = registerImeIpc();
    const restore = destroyMainWindow();

    try {
      expect(() => controller.dispose()).not.toThrow();
    } finally {
      restore();
    }
  });

  it("records the superseded lease when another window takes ownership", async () => {
    const first = leaseGeneration(await acquire(11, "main-composer"));
    vi.mocked(logImeDiagnostic).mockClear();

    await acquire(22, "reply-composer");

    expect(logImeDiagnostic).toHaveBeenCalledWith(
      "lease-released",
      expect.objectContaining({
        windowId: 1,
        targetId: "main-composer",
        generation: first,
        reason: "owner-replaced",
        nextTargetId: "reply-composer",
      }),
    );
  });

  it("records a native isolation failure as the reason a lease disappears", async () => {
    const first = leaseGeneration(await acquire(11, "main-composer"));
    vi.mocked(logImeDiagnostic).mockClear();
    shared.isolateNativeIme.mockReturnValueOnce("failed");

    await acquire(22, "reply-composer");

    expect(vi.mocked(logImeDiagnostic).mock.calls).toContainEqual([
      "lease-released",
      expect.objectContaining({
        targetId: "main-composer",
        generation: first,
        reason: "native-ime-isolation-failed",
      }),
    ]);
    expect(vi.mocked(logImeDiagnostic).mock.calls).toContainEqual([
      "lease-unavailable",
      expect.objectContaining({
        targetId: "reply-composer",
        reason: "native-ime-isolation-failed",
      }),
    ]);
  });

  it("records the lease status a renderer resume came from", async () => {
    const acquired = (await invoke(ImeChannels.SessionCommand, 11, {
      type: "acquireTarget",
      commandId: "acquire-resume",
      targetId: "main-composer",
    })) as { snapshot: { owner: { generation: number } } };
    vi.mocked(logImeDiagnostic).mockClear();

    await invoke(ImeChannels.SessionCommand, 11, {
      type: "resume",
      commandId: "resume-1",
      targetId: "main-composer",
      generation: acquired.snapshot.owner.generation,
    });

    expect(logImeDiagnostic).toHaveBeenCalledWith("lease-resumed", {
      windowId: 1,
      targetId: "main-composer",
      generation: acquired.snapshot.owner.generation,
      previousStatus: "owned",
    });
  });

  it("cancels the previous target composition on transfer while retaining engine mode", async () => {
    const generation = leaseGeneration(await acquire(11, "main-composer"));
    shared.bridge.snapshot = { ...emptyState, enabled: true, inputMode: "ascii", composing: true };

    const second = await acquire(22, "reply-composer");

    expect(shared.bridge.reset).toHaveBeenCalledOnce();
    expect(shared.bridge.enable).toHaveBeenCalledOnce();
    expect(second).toMatchObject({
      accepted: true,
      snapshot: {
        owner: { targetId: "reply-composer", generation: generation + 1 },
        engine: { enabled: true, inputMode: "ascii" },
      },
    });
  });

  it("does not expose a new owner until the previous composition has been reset", async () => {
    const first = leaseGeneration(await acquire(11, "main-composer"));
    shared.bridge.snapshot = {
      ...emptyState,
      enabled: true,
      composing: true,
      preedit: "ni",
      candidates: [{ text: "你" }],
    };
    shared.isolateNativeIme.mockClear();

    let finishReset: (() => void) | undefined;
    let resetStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resetStarted = resolve;
    });
    shared.bridge.reset.mockImplementationOnce(async () => {
      resetStarted?.();
      await new Promise<void>((resolve) => {
        finishReset = resolve;
      });
      shared.bridge.snapshot = {
        ...shared.bridge.snapshot,
        composing: false,
        preedit: "",
        candidates: [],
      };
      return shared.bridge.snapshot;
    });

    const nextLease = acquire(22, "reply-composer");
    await started;
    expect(shared.isolateNativeIme).not.toHaveBeenCalled();

    const staleKey = invoke(ImeChannels.SessionCommand, 11, {
      type: "processKey",
      commandId: "old-target-key",
      targetId: "main-composer",
      generation: first,
      key: "n",
      code: "KeyN",
      shift: false,
      ctrl: false,
      alt: false,
      meta: false,
    });
    const staleCandidate = invoke(ImeChannels.SessionCommand, 11, {
      type: "selectCandidate",
      commandId: "old-target-candidate",
      targetId: "main-composer",
      generation: first,
      index: 0,
    });
    let snapshotResolved = false;
    const snapshot = invoke(ImeChannels.SessionSnapshot, 22).then((result) => {
      snapshotResolved = true;
      return result;
    });
    await Promise.resolve();
    expect(snapshotResolved).toBe(false);

    finishReset?.();
    const acquired = await nextLease;
    expect(acquired).toMatchObject({
      accepted: true,
      snapshot: { owner: { targetId: "reply-composer" } },
    });
    expect(acquired).not.toHaveProperty("commit");
    expect(shared.isolateNativeIme).toHaveBeenCalledOnce();
    await expect(staleKey).resolves.toMatchObject({ accepted: false });
    await expect(staleCandidate).resolves.toMatchObject({ accepted: false });
    expect(shared.bridge.key).not.toHaveBeenCalled();
    expect(shared.bridge.select).not.toHaveBeenCalled();
    await expect(snapshot).resolves.toMatchObject({
      snapshot: {
        owner: { targetId: "reply-composer" },
        engine: { composing: false, preedit: "", candidates: [] },
      },
    });
    expect(first).toBe(1);
  });

  it("suspends the lease from the shared native focus stream after an app switch", async () => {
    const generation = leaseGeneration(await acquire(11, "main-composer"));
    vi.useFakeTimers();
    shared.focusedWindow = undefined;
    shared.appForeground = false;
    for (const listener of shared.focusSubscribers)
      listener({ window: shared.main, focused: false, visible: true });

    await vi.advanceTimersByTimeAsync(120);

    expect(logImeDiagnostic).toHaveBeenCalledWith(
      "lease-suspended",
      expect.objectContaining({ windowId: 1, generation }),
    );
    expect(shared.isolateNativeIme).toHaveBeenCalledWith(shared.main);
    expect(shared.setImeCandidateState).toHaveBeenCalledWith(shared.main, {
      type: "suspend",
      targetId: "main-composer",
      generation,
    });
    vi.useRealTimers();
  });

  it("reapplies native IME isolation when the owning window regains focus", async () => {
    await acquire(11, "main-composer");
    shared.isolateNativeIme.mockClear();

    for (const listener of shared.focusSubscribers)
      listener({ window: shared.main, focused: true, visible: true });

    expect(shared.isolateNativeIme).toHaveBeenCalledOnce();
    expect(shared.isolateNativeIme).toHaveBeenCalledWith(shared.main);
  });

  it("suspends the lease if native IME isolation fails after focus returns", async () => {
    const generation = leaseGeneration(await acquire(11, "main-composer"));
    shared.isolateNativeIme.mockReturnValue("failed");

    for (const listener of shared.focusSubscribers)
      listener({ window: shared.main, focused: true, visible: true });

    expect(shared.setImeCandidateState).toHaveBeenCalledWith(shared.main, {
      type: "suspend",
      targetId: "main-composer",
      generation,
    });
    expect(logImeDiagnostic).toHaveBeenCalledWith("native-ime-isolation-failed-on-focus", {
      windowId: shared.main.id,
      generation,
    });
  });

  it("keeps an owned lease when the owner re-sends a focus confirmation", async () => {
    shared.isolateNativeIme.mockReturnValue("not-required");
    const lease = (await invoke(ImeChannels.SessionCommand, 11, {
      type: "acquireTarget",
      commandId: "acquire-owned",
      targetId: "main-composer",
    })) as { snapshot: { owner: { generation: number } } };
    const generation = lease.snapshot.owner.generation;
    shared.isolateNativeIme.mockClear();

    await expect(
      invoke(ImeChannels.SessionCommand, 11, {
        type: "resume",
        commandId: "resume-owned",
        targetId: "main-composer",
        generation,
      }),
    ).resolves.toMatchObject({
      accepted: true,
      snapshot: { phase: "owned", owner: { targetId: "main-composer", generation } },
    });
    expect(shared.isolateNativeIme).not.toHaveBeenCalled();
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
        targetRegistered: false,
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
        targetRegistered: true,
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
      targetRegistered: true,
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

  it("always carries a snapshot and only explains rejected results with a reason", async () => {
    const accepted = (await acquire(11, "main-composer")) as ImeSessionCommandResult;
    expect(accepted.accepted).toBe(true);
    expect(accepted.snapshot.phase).toBe("owned");
    expect(accepted).not.toHaveProperty("reason");

    const rejected = (await invoke(ImeChannels.SessionCommand, 11, {
      type: "processKey",
      commandId: "non-owner-envelope",
      targetId: "reply-composer",
      generation: leaseGeneration(accepted),
      key: "n",
      code: "KeyN",
      shift: false,
      ctrl: false,
      alt: false,
      meta: false,
    })) as ImeSessionCommandResult;

    expect(rejected.accepted).toBe(false);
    expect(rejected.reason).toBe("stale-owner");
    expect(rejected.snapshot.phase).toBe("owned");
  });

  it("attaches commit only when the engine produced text and engineHandled only for processKey", async () => {
    const generation = leaseGeneration(await acquire(11, "main-composer"));

    const keyed = (await invoke(ImeChannels.SessionCommand, 11, {
      type: "processKey",
      commandId: "envelope-plain-key",
      targetId: "main-composer",
      generation,
      key: "n",
      code: "KeyN",
      shift: false,
      ctrl: false,
      alt: false,
      meta: false,
    })) as ImeSessionCommandResult;
    expect(keyed).not.toHaveProperty("commit");
    expect(keyed.engineHandled).toBe(true);

    shared.bridge.key.mockImplementationOnce(async () => ({
      ...emptyState,
      enabled: true,
      committedText: "ni",
      handled: true,
    }));
    const committed = (await invoke(ImeChannels.SessionCommand, 11, {
      type: "processKey",
      commandId: "envelope-committing-key",
      targetId: "main-composer",
      generation,
      key: " ",
      code: "Space",
      shift: false,
      ctrl: false,
      alt: false,
      meta: false,
    })) as ImeSessionCommandResult;
    expect(committed.commit?.text).toBe("ni");

    shared.bridge.select.mockImplementationOnce(async () => ({
      ...emptyState,
      enabled: true,
      committedText: "你",
    }));
    const selected = (await invoke(ImeChannels.SessionCommand, 11, {
      type: "selectCandidate",
      commandId: "envelope-candidate",
      targetId: "main-composer",
      generation,
      index: 0,
    })) as ImeSessionCommandResult;
    expect(selected.commit?.text).toBe("你");
    expect(selected).not.toHaveProperty("engineHandled");
  });

  it("records the release reason when the renderer process is gone", async () => {
    shared.main.webContents.on.mockClear();
    const generation = leaseGeneration(await acquire(11, "main-composer"));
    vi.mocked(logImeDiagnostic).mockClear();
    const onGone = shared.main.webContents.on.mock.calls.find(
      ([event]) => event === "render-process-gone",
    )?.[1] as (() => void) | undefined;

    onGone?.();

    expect(logImeDiagnostic).toHaveBeenCalledWith(
      "lease-released",
      expect.objectContaining({
        windowId: 1,
        targetId: "main-composer",
        generation,
        reason: "renderer-process-gone",
      }),
    );
  });

  it("records the release reason when the owner window navigates", async () => {
    shared.main.webContents.on.mockClear();
    const generation = leaseGeneration(await acquire(11, "main-composer"));
    vi.mocked(logImeDiagnostic).mockClear();
    const onNavigation = shared.main.webContents.on.mock.calls.find(
      ([event]) => event === "did-start-navigation",
    )?.[1] as
      | ((event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void)
      | undefined;

    onNavigation?.({}, "answra://main", false, true);

    expect(logImeDiagnostic).toHaveBeenCalledWith(
      "lease-released",
      expect.objectContaining({
        windowId: 1,
        targetId: "main-composer",
        generation,
        reason: "window-navigation",
      }),
    );
  });
});

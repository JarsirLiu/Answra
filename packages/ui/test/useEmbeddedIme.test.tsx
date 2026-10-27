import type {
  DesktopBridge,
  ImeCandidateAction,
  ImeKeyboardInput,
  ImeLeaseResponse,
  ImeSessionCommand,
  ImeSessionSnapshot,
  ImeState,
} from "@answra/shared";
import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEmbeddedIme } from "../src/hooks/useEmbeddedIme";
import { resetImeInputTargetCoordinatorForTests } from "../src/ime/imeInputTargetCoordinator";
import { publishImeSessionSnapshot } from "../src/ime/imeSessionClient";

const enabledState: ImeState = {
  enabled: true,
  inputMode: "chinese",
  composing: true,
  preedit: "ni",
  candidates: [{ text: "你" }],
  selectedIndex: 0,
  page: 0,
  hasNextPage: false,
};
const lease = (generation: number, state = enabledState): ImeLeaseResponse => ({
  state,
  targetId: "composer",
  generation,
  accepted: true,
});

const typedBridges = new WeakMap<DesktopBridge, DesktopBridge>();

/**
 * Test-only scaffolding: the suite still configures the engine through the removed
 * `ime*` domain methods, and `withSessionApi` translates them onto the single
 * `imeSessionCommand` entry point the renderer now uses.
 */
type LegacyImeBridge = DesktopBridge & {
  imeAcquire?: (targetId: string) => Promise<ImeLeaseResponse>;
  imeRelease?: (generation: number) => Promise<ImeLeaseResponse>;
  imeConfirmFocus?: (targetId: string, generation: number) => Promise<ImeLeaseResponse>;
  imeKey?: (request: ImeSessionCommand) => Promise<ImeState>;
  imeSelect?: (index: number, generation: number) => Promise<ImeState>;
  imeReset?: (generation: number) => Promise<ImeState>;
};

function withSessionApi(legacyBridge: DesktopBridge): DesktopBridge {
  const legacy = legacyBridge as LegacyImeBridge;
  const existing = typedBridges.get(legacyBridge);
  if (existing) return existing;
  let state: ImeState = {
    ...enabledState,
    enabled: false,
    composing: false,
    preedit: "",
    candidates: [],
  };
  let owner: ImeSessionSnapshot["owner"];
  let phase: ImeSessionSnapshot["phase"] = "idle";
  let revision = 0;
  const listeners = new Set<(snapshot: ImeSessionSnapshot) => void>();
  const snapshot = (): ImeSessionSnapshot => ({
    phase,
    ...(owner ? { owner } : {}),
    engine: {
      enabled: state.enabled,
      inputMode: state.inputMode,
      composing: state.composing,
      preedit: state.preedit,
      candidates: state.candidates,
      selectedIndex: state.selectedIndex,
      page: state.page,
      hasNextPage: state.hasNextPage,
    },
    revision,
  });
  const bridge = {
    ...legacyBridge,
    imeSessionCommand: vi.fn(async (command: ImeSessionCommand) => {
      let response: unknown;
      if (command.type === "acquireTarget") {
        response = await legacy.imeAcquire?.(command.targetId);
        const acquired = response as ImeLeaseResponse | undefined;
        if (acquired?.accepted && acquired.generation !== undefined) {
          state = acquired.state;
          owner = {
            windowId: 1,
            webContentsId: 1,
            targetId: command.targetId,
            generation: acquired.generation,
          };
          phase = "owned";
        }
      } else {
        switch (command.type) {
          case "releaseTarget":
            response = await legacy.imeRelease?.(command.generation);
            phase = "idle";
            owner = undefined;
            break;
          case "resume":
            response = await legacy.imeConfirmFocus?.(command.targetId, command.generation);
            phase = "owned";
            break;
          case "processKey":
            response = await legacy.imeKey?.(command);
            break;
          case "cancelComposition":
            response = await legacy.imeReset?.(command.generation);
            break;
          case "selectCandidate":
            response = await legacy.imeSelect?.(command.index, command.generation);
            break;
          case "suspend":
            phase = "suspended";
            response = { enabled: state.enabled };
            break;
        }
      }
      const wrapped = response as (ImeLeaseResponse & Partial<ImeState>) | ImeState | undefined;
      if (wrapped && "state" in wrapped && wrapped.state && "enabled" in wrapped.state)
        state = wrapped.state as ImeState;
      else if (wrapped && "enabled" in wrapped && wrapped.enabled !== undefined)
        state = wrapped as ImeState;
      else if (!state.enabled && command.type === "processKey") state = { ...state, enabled: true };
      revision += 1;
      const nextSnapshot = snapshot();
      for (const listener of listeners) listener(nextSnapshot);
      return {
        commandId: command.commandId,
        accepted:
          wrapped && "accepted" in wrapped
            ? wrapped.accepted
            : command.type === "suspend" || state.enabled,
        snapshot: nextSnapshot,
        ...(command.type === "processKey" &&
        typeof (wrapped as ImeState | undefined)?.handled === "boolean"
          ? { engineHandled: (wrapped as ImeState).handled }
          : {}),
        ...(state.committedText ? { commit: { text: state.committedText, revision } } : {}),
      };
    }),
    getImeSessionSnapshot: async () => snapshot(),
    onImeSessionSnapshot: (listener: (next: ImeSessionSnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as DesktopBridge;
  typedBridges.set(legacyBridge, bridge);
  return bridge;
}

describe("useEmbeddedIme lease routing", () => {
  beforeEach(() => resetImeInputTargetCoordinatorForTests());

  it("sends both Shift edges to Rime and updates mode only from its snapshot", async () => {
    const imeKey = vi.fn(async (request: { release?: boolean }) => ({
      ...enabledState,
      composing: false,
      preedit: "",
      candidates: [],
      inputMode: request.release ? "ascii" : "chinese",
    }));
    const bridge = withSessionApi({
      imeAvailable: true,
      imeKey,
      imeAcquire: vi.fn().mockResolvedValue(lease(3, { ...enabledState, composing: false })),
      imeRelease: vi.fn(),
    } as unknown as DesktopBridge);
    const { result } = renderHook(() => useEmbeddedIme(bridge, undefined, true, "composer"));
    const input = document.createElement("input");
    input.dataset.imeTargetId = "composer";
    document.body.appendChild(input);
    input.focus();
    await act(async () => result.current.acquire());

    const shiftDown = {
      key: "Shift",
      code: "ShiftLeft",
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: true,
      repeat: false,
    };
    const shiftUp = { ...shiftDown, shiftKey: false };
    act(() => {
      expect(result.current.sendKey(shiftDown as never)).toBe(true);
      expect(result.current.sendKeyUp(shiftUp as never)).toBe(true);
    });

    await waitFor(() => expect(result.current.asciiMode).toBe(true));
    expect(imeKey).toHaveBeenCalledTimes(2);
    expect(imeKey).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ key: "Shift", code: "ShiftLeft", release: false }),
    );
    expect(imeKey).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ key: "Shift", code: "ShiftLeft", release: true }),
    );
    const commandApi = bridge.imeSessionCommand;
    if (!commandApi) throw new Error("typed session API was not installed");
    const commands = vi.mocked(commandApi).mock.calls.map(([command]) => command);
    expect(commands).toHaveLength(3);
    expect(new Set(commands.map((command) => command.commandId)).size).toBe(3);
    input.remove();
  });

  it("preserves native Shift ordering for rapid presses", async () => {
    const modes: string[] = [];
    let inputMode: "chinese" | "ascii" = "chinese";
    const bridge = withSessionApi({
      imeAvailable: true,
      imeAcquire: vi.fn().mockResolvedValue(lease(32, { ...enabledState, composing: false })),
      imeKey: vi.fn(async (request: { release?: boolean }) => {
        if (request.release) inputMode = inputMode === "ascii" ? "chinese" : "ascii";
        modes.push(inputMode);
        return { ...enabledState, composing: false, inputMode };
      }),
    } as unknown as DesktopBridge);
    const { result } = renderHook(() => useEmbeddedIme(bridge, undefined, true, "composer"));
    const input = document.createElement("input");
    input.dataset.imeTargetId = "composer";
    document.body.appendChild(input);
    input.focus();
    await act(async () => result.current.acquire());
    const shift = {
      key: "Shift",
      code: "ShiftLeft",
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: true,
      repeat: false,
    };

    act(() => {
      result.current.sendKey(shift as never);
      result.current.sendKeyUp({ ...shift, shiftKey: false } as never);
      result.current.sendKey(shift as never);
      result.current.sendKeyUp({ ...shift, shiftKey: false } as never);
    });
    await waitFor(() => expect(modes).toHaveLength(4));
    expect(modes).toEqual(["chinese", "ascii", "ascii", "chinese"]);
    expect(result.current.asciiMode).toBe(false);
    input.remove();
  });

  it("queues printable text after Shift and inserts only after the ASCII snapshot returns", async () => {
    let resolveShiftUp: ((state: ImeState) => void) | undefined;
    const imeKey = vi.fn((request: { key: string; release?: boolean }) => {
      if (request.key === "Shift" && request.release)
        return new Promise<ImeState>((resolve) => {
          resolveShiftUp = resolve;
        });
      return Promise.resolve({
        ...enabledState,
        handled: false,
        composing: false,
        preedit: "",
        candidates: [],
        inputMode: request.key === "a" ? "ascii" : "chinese",
      });
    });
    const onCommit = vi.fn();
    const bridge = withSessionApi({
      imeAvailable: true,
      imeKey,
      imeAcquire: vi.fn().mockResolvedValue(lease(8, { ...enabledState, composing: false })),
      imeRelease: vi.fn(),
    } as unknown as DesktopBridge);
    const { result } = renderHook(() => useEmbeddedIme(bridge, onCommit, true, "composer"));
    const input = document.createElement("input");
    input.dataset.imeTargetId = "composer";
    document.body.appendChild(input);
    input.focus();
    await act(async () => result.current.acquire());
    const shift = {
      key: "Shift",
      code: "ShiftLeft",
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: true,
      repeat: false,
    };
    act(() => {
      expect(result.current.sendKey(shift as never)).toBe(true);
      expect(result.current.sendKeyUp({ ...shift, shiftKey: false } as never)).toBe(true);
      expect(
        result.current.sendKey({ ...shift, key: "a", code: "KeyA", shiftKey: false } as never),
      ).toBe(true);
    });
    await waitFor(() => expect(resolveShiftUp).toBeDefined());
    expect(imeKey).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolveShiftUp?.({
        ...enabledState,
        handled: false,
        composing: false,
        preedit: "",
        candidates: [],
        inputMode: "ascii",
      });
    });
    await waitFor(() => expect(imeKey).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("a"));
    expect(imeKey).toHaveBeenNthCalledWith(3, expect.objectContaining({ key: "a" }));
    input.remove();
  });

  it("routes Backspace using the snapshot produced by the preceding queued key", async () => {
    const imeKey = vi.fn(async (request: { key: string }) => ({
      ...enabledState,
      handled: true,
      composing: request.key === "n" || request.key === "Backspace",
      preedit: request.key === "n" ? "n" : "",
      candidates: [],
    }));
    const bridge = withSessionApi({
      imeAvailable: true,
      imeAcquire: vi
        .fn()
        .mockResolvedValue(
          lease(44, { ...enabledState, composing: false, preedit: "", candidates: [] }),
        ),
      imeKey,
      imeRelease: vi.fn(),
    } as unknown as DesktopBridge);
    const { result } = renderHook(() => useEmbeddedIme(bridge, undefined, true, "composer"));
    const input = document.createElement("input");
    input.dataset.imeTargetId = "composer";
    document.body.appendChild(input);
    input.focus();
    await act(async () => result.current.acquire());
    const event = (key: string, code = key) =>
      ({
        key,
        code,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
      }) as never;

    act(() => {
      expect(result.current.sendKey(event("n", "KeyN"))).toBe(true);
      expect(result.current.sendKey(event("Backspace"))).toBe(true);
    });
    await waitFor(() => expect(imeKey).toHaveBeenCalledTimes(2));
    expect(imeKey.mock.calls.map(([request]) => request.key)).toEqual(["n", "Backspace"]);
    input.remove();
  });

  it("lets the browser own vertical navigation while not composing", async () => {
    const imeKey = vi.fn();
    const bridge = withSessionApi({
      imeAvailable: true,
      imeKey,
      imeAcquire: vi
        .fn()
        .mockResolvedValue(
          lease(7, { ...enabledState, composing: false, preedit: "", candidates: [] }),
        ),
      imeRelease: vi.fn(),
    } as unknown as DesktopBridge);
    const { result } = renderHook(() => useEmbeddedIme(bridge, undefined, true, "composer"));
    const input = document.createElement("textarea");
    input.dataset.imeTargetId = "composer";
    document.body.appendChild(input);
    input.focus();
    await act(async () => result.current.acquire());

    // handled=false：调用方不 preventDefault，浏览器原生上下移动（感知折行）接管。
    act(() => {
      expect(
        result.current.sendKey({
          key: "ArrowDown",
          code: "ArrowDown",
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          shiftKey: false,
          repeat: false,
        } as never),
      ).toBe(false);
    });
    expect(imeKey).not.toHaveBeenCalled();
    input.remove();
  });

  it("keeps vertical navigation on the engine while composing", async () => {
    const imeKey = vi.fn(async () => ({ ...enabledState }));
    const bridge = withSessionApi({
      imeAvailable: true,
      imeKey,
      imeAcquire: vi.fn().mockResolvedValue(lease(9)),
      imeRelease: vi.fn(),
    } as unknown as DesktopBridge);
    const { result } = renderHook(() => useEmbeddedIme(bridge, undefined, true, "composer"));
    const input = document.createElement("textarea");
    input.dataset.imeTargetId = "composer";
    document.body.appendChild(input);
    input.focus();
    await act(async () => result.current.acquire());

    act(() => {
      expect(
        result.current.sendKey({
          key: "ArrowDown",
          code: "ArrowDown",
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          shiftKey: false,
          repeat: false,
        } as never),
      ).toBe(true);
    });
    await waitFor(() => expect(imeKey).toHaveBeenCalled());
    input.remove();
  });

  it("synchronizes the engine-reported Shift mode across input targets", async () => {
    const bridge = withSessionApi({
      imeAvailable: true,
      imeAcquire: vi.fn().mockResolvedValue(lease(31, { ...enabledState, composing: false })),
      imeKey: vi.fn(async (request: { key: string; release?: boolean }) => ({
        ...enabledState,
        inputMode: request.key === "Shift" && request.release ? "ascii" : "chinese",
      })),
      imeRelease: vi.fn(),
    } as unknown as DesktopBridge);
    const first = renderHook(() => useEmbeddedIme(bridge, undefined, true, "composer"));
    const second = renderHook(() => useEmbeddedIme(bridge, undefined, true, "settings-model"));
    const input = document.createElement("input");
    input.dataset.imeTargetId = "composer";
    document.body.appendChild(input);
    input.focus();
    await act(async () => first.result.current.acquire());
    act(() => {
      first.result.current.sendKey({
        key: "Shift",
        code: "ShiftLeft",
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: true,
        repeat: false,
      } as never);
      first.result.current.sendKeyUp({
        key: "Shift",
        code: "ShiftLeft",
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
      } as never);
    });

    await waitFor(() => expect(second.result.current.asciiMode).toBe(true));
    first.unmount();
    second.unmount();
    input.remove();
  });

  it("applies composition and candidate changes exactly as returned by Rime", async () => {
    const imeKey = vi
      .fn()
      .mockResolvedValueOnce(enabledState)
      .mockResolvedValueOnce({
        ...enabledState,
        inputMode: "ascii",
        candidates: [],
      });
    const onCommit = vi.fn();
    const bridge = withSessionApi({
      imeAvailable: true,
      imeKey,
      imeAcquire: vi.fn().mockResolvedValue(lease(9)),
      imeRelease: vi.fn(),
    } as unknown as DesktopBridge);
    const { result } = renderHook(() => useEmbeddedIme(bridge, onCommit, true, "composer"));
    const input = document.createElement("input");
    input.dataset.imeTargetId = "composer";
    document.body.appendChild(input);
    input.focus();
    await act(async () => result.current.acquire());
    const shift = {
      key: "Shift",
      code: "ShiftLeft",
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: true,
      repeat: false,
    };
    act(() => {
      result.current.sendKey(shift as never);
      result.current.sendKeyUp({ ...shift, shiftKey: false } as never);
    });
    await waitFor(() => expect(result.current.asciiMode).toBe(true));

    expect(imeKey).toHaveBeenCalledTimes(2);
    expect(result.current.state).toMatchObject({
      inputMode: "ascii",
      composing: true,
      preedit: "ni",
      candidates: [],
    });
    expect(onCommit).not.toHaveBeenCalled();
    input.remove();
  });

  it("uses the engine result before inserting an unshifted Chinese-mode digit", async () => {
    const imeKey = vi.fn().mockResolvedValue({
      ...enabledState,
      handled: false,
      composing: false,
      preedit: "",
      candidates: [],
    });
    const onCommit = vi.fn();
    const bridge = {
      imeAvailable: true,
      imeKey,
      imeAcquire: vi.fn().mockResolvedValue(lease(10, { ...enabledState, composing: false })),
      imeRelease: vi.fn(),
    } as unknown as DesktopBridge;
    const { result } = renderHook(() =>
      useEmbeddedIme(withSessionApi(bridge), onCommit, true, "composer"),
    );
    const input = document.createElement("input");
    input.dataset.imeTargetId = "composer";
    document.body.appendChild(input);
    input.focus();
    await act(async () => result.current.acquire());

    act(() =>
      expect(
        result.current.sendKey({
          key: "7",
          code: "Digit7",
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          shiftKey: false,
          repeat: false,
        } as never),
      ).toBe(true),
    );

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("7"));
    expect(imeKey).toHaveBeenCalledWith(expect.objectContaining({ key: "7" }));
    input.remove();
  });

  it("keeps digits routed to Rime when a candidate composition is active", async () => {
    const imeKey = vi.fn().mockResolvedValue(enabledState);
    const bridge = {
      imeAvailable: true,
      imeKey,
      imeAcquire: vi.fn().mockResolvedValue(lease(11)),
      imeRelease: vi.fn(),
    } as unknown as DesktopBridge;
    const { result } = renderHook(() =>
      useEmbeddedIme(withSessionApi(bridge), undefined, true, "composer"),
    );
    const input = document.createElement("input");
    input.dataset.imeTargetId = "composer";
    document.body.appendChild(input);
    input.focus();
    await act(async () => result.current.acquire());

    act(() =>
      result.current.sendKey({
        key: "1",
        code: "Digit1",
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
      } as never),
    );
    await waitFor(() => expect(imeKey).toHaveBeenCalledWith(expect.objectContaining({ key: "1" })));
    input.remove();
  });

  it("acquires on editor focus and confirms the same generation after window focus", async () => {
    const imeAcquire = vi.fn().mockResolvedValue(lease(4));
    const imeConfirmFocus = vi.fn().mockResolvedValue(lease(4));
    const bridge = {
      imeAvailable: true,
      imeKey: vi.fn(),
      imeAcquire,
      imeConfirmFocus,
      imeRelease: vi.fn(),
    } as unknown as DesktopBridge;
    const { result } = renderHook(() =>
      useEmbeddedIme(withSessionApi(bridge), undefined, true, "composer"),
    );
    const input = document.createElement("input");
    input.dataset.imeTargetId = "composer";
    document.body.appendChild(input);

    await act(async () => result.current.acquire());
    expect(imeAcquire).toHaveBeenCalledWith("composer");
    expect(result.current.generation).toBe(4);
    input.focus();
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(imeConfirmFocus).toHaveBeenCalledWith("composer", 4));
    input.remove();
  });

  it("delivers only current-lease native keys to the active DOM editor without focusing the window", async () => {
    let receiveKeyboardInput: ((input: ImeKeyboardInput) => void) | undefined;
    const bridge = withSessionApi({
      imeAvailable: true,
      imeAcquire: vi.fn().mockResolvedValue(lease(45)),
      ackImeKeyboardInput: vi.fn(async () => true),
      onImeKeyboardInput: (listener: (input: ImeKeyboardInput) => void) => {
        receiveKeyboardInput = listener;
        return () => {
          receiveKeyboardInput = undefined;
        };
      },
    } as unknown as DesktopBridge);
    const { result, unmount } = renderHook(() =>
      useEmbeddedIme(bridge, undefined, true, "composer"),
    );
    const input = document.createElement("textarea");
    input.dataset.imeTargetId = "composer";
    const receivedKeys: KeyboardEvent[] = [];
    input.addEventListener("keydown", (event) => {
      receivedKeys.push(event);
      event.preventDefault();
    });
    document.body.appendChild(input);
    input.focus();
    await act(async () => result.current.acquire());

    act(() => {
      receiveKeyboardInput?.({
        targetId: "composer",
        generation: 45,
        eventId: 17,
        type: "keydown",
        key: "n",
        code: "KeyN",
        shift: false,
        ctrl: false,
        alt: false,
        meta: false,
        repeat: false,
      });
      receiveKeyboardInput?.({
        targetId: "composer",
        generation: 44,
        eventId: 18,
        type: "keydown",
        key: "x",
        code: "KeyX",
        shift: false,
        ctrl: false,
        alt: false,
        meta: false,
        repeat: false,
      });
    });

    expect(receivedKeys.map((event) => event.key)).toEqual(["n"]);
    expect(bridge.ackImeKeyboardInput).toHaveBeenCalledWith({
      targetId: "composer",
      generation: 45,
      eventId: 17,
      delivered: true,
    });
    expect(bridge.ackImeKeyboardInput).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input);
    unmount();
    input.remove();
  });

  it("reports renderer focus and key routing with the typed key for local diagnostics", async () => {
    const imeDiagnostic = vi.fn();
    const bridge = {
      imeAvailable: true,
      imeKey: vi.fn().mockResolvedValue(enabledState),
      imeAcquire: vi.fn().mockResolvedValue(lease(6)),
      imeRelease: vi.fn(),
      imeDiagnostic,
    } as unknown as DesktopBridge;
    const { result } = renderHook(() =>
      useEmbeddedIme(withSessionApi(bridge), undefined, true, "composer"),
    );
    const input = document.createElement("input");
    input.dataset.imeTargetId = "composer";
    document.body.appendChild(input);
    input.focus();

    await act(async () => result.current.acquire());
    act(() =>
      result.current.sendKey({
        key: "n",
        code: "KeyN",
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
      } as never),
    );
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "x", code: "KeyX" }),
      );
    });

    expect(imeDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "input-mounted",
        activeElementTarget: false,
      }),
    );
    expect(imeDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "acquire-result",
        accepted: true,
        generation: 6,
        activeElementTarget: true,
      }),
    );
    expect(imeDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "document-keydown",
        keyCode: "KeyX",
        keyKind: "text",
      }),
    );
    expect(
      imeDiagnostic.mock.calls.some(([diagnostic]) => diagnostic.event === "key-routing"),
    ).toBe(false);
    input.remove();
  });

  it("records shortcut routing and selection ranges without recording input text", async () => {
    const imeDiagnostic = vi.fn();
    const bridge = {
      imeAvailable: true,
      imeKey: vi.fn().mockResolvedValue(enabledState),
      imeAcquire: vi.fn().mockResolvedValue(lease(9)),
      imeRelease: vi.fn(),
      imeDiagnostic,
    } as unknown as DesktopBridge;
    const { result } = renderHook(() =>
      useEmbeddedIme(withSessionApi(bridge), undefined, true, "composer"),
    );
    const input = document.createElement("input");
    input.dataset.imeTargetId = "composer";
    input.value = "private draft";
    document.body.appendChild(input);
    input.focus();
    await act(async () => result.current.acquire());
    input.setSelectionRange(0, input.value.length);

    await act(async () => {
      result.current.sendKey({
        key: "a",
        code: "KeyA",
        ctrlKey: true,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
        target: input,
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.keyUp(input, { key: "a", code: "KeyA", ctrlKey: true });

    expect(imeDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "key-routing",
        key: "a",
        ctrl: true,
        composing: true,
        accepted: false,
        selectionStart: 0,
        selectionEnd: 13,
        selectionLength: 13,
        valueLength: 13,
      }),
    );
    expect(imeDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "selection-after-shortcut",
        key: "a",
        selectionStart: 0,
        selectionEnd: 13,
        selectionLength: 13,
        valueLength: 13,
      }),
    );
    expect(JSON.stringify(imeDiagnostic.mock.calls)).not.toContain("private draft");
    input.remove();
  });

  it("releases only its own lease when the hook unmounts", async () => {
    const imeRelease = vi.fn().mockResolvedValue(lease(2));
    const bridge = {
      imeAvailable: true,
      imeKey: vi.fn(),
      imeAcquire: vi.fn().mockResolvedValue(lease(2)),
      imeRelease,
    } as unknown as DesktopBridge;
    const { result, unmount } = renderHook(() => useEmbeddedIme(withSessionApi(bridge)));
    await act(async () => result.current.acquire());
    expect(result.current.generation).toBe(2);
    expect(imeRelease).not.toHaveBeenCalled();
    unmount();
    await waitFor(() => expect(imeRelease).toHaveBeenCalledWith(2));
    expect(imeRelease).toHaveBeenCalledTimes(1);
  });

  it("does not release on DOM blur before the native window blur event arrives", async () => {
    const imeRelease = vi.fn();
    const bridge = withSessionApi({
      imeAvailable: true,
      imeAcquire: vi.fn().mockResolvedValue(lease(13)),
      imeRelease,
    } as unknown as DesktopBridge);
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { result } = renderHook(() => useEmbeddedIme(bridge, undefined, true, "composer"));
    const input = document.createElement("textarea");
    input.dataset.imeTargetId = "composer";
    document.body.appendChild(input);
    input.focus();
    await act(async () => result.current.acquire());

    input.blur();
    act(() => result.current.blur());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 170)));

    expect(imeRelease).not.toHaveBeenCalled();
    expect(result.current.generation).toBe(13);
    act(() => window.dispatchEvent(new Event("blur")));
    hasFocus.mockRestore();
    input.remove();
  });

  it("does not create an input target from window focus alone", async () => {
    const imeAcquire = vi.fn();
    const bridge = withSessionApi({
      imeAvailable: true,
      imeAcquire,
    } as unknown as DesktopBridge);
    const { result, unmount } = renderHook(() =>
      useEmbeddedIme(bridge, undefined, true, "composer"),
    );
    const input = document.createElement("textarea");
    input.dataset.imeTargetId = "composer";
    document.body.appendChild(input);
    input.focus();

    act(() => window.dispatchEvent(new Event("focus")));

    expect(imeAcquire).not.toHaveBeenCalled();
    expect(result.current.generation).toBeUndefined();
    unmount();
    input.remove();
  });

  it("keeps the lease but stops routing keys after focus moves to a non-IME element", async () => {
    const imeRelease = vi.fn();
    const imeKey = vi.fn();
    const bridge = withSessionApi({
      imeAvailable: true,
      imeAcquire: vi.fn().mockResolvedValue(lease(14)),
      imeRelease,
      imeKey,
    } as unknown as DesktopBridge);
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { result } = renderHook(() => useEmbeddedIme(bridge, undefined, true, "composer"));
    const input = document.createElement("textarea");
    input.dataset.imeTargetId = "composer";
    const button = document.createElement("button");
    document.body.append(input, button);
    input.focus();
    await act(async () => result.current.acquire());

    act(() => {
      button.focus();
      result.current.blur();
    });
    expect(result.current.generation).toBe(14);
    expect(result.current.sendKey(new KeyboardEvent("keydown", { key: "n", code: "KeyN" }))).toBe(
      false,
    );
    expect(imeRelease).not.toHaveBeenCalled();
    expect(imeKey).not.toHaveBeenCalled();

    hasFocus.mockRestore();
    input.remove();
    button.remove();
  });

  it("ignores candidate actions from stale targets and generations", async () => {
    let receiveAction: ((action: ImeCandidateAction) => void) | undefined;
    const imeSelect = vi.fn().mockResolvedValue({ ...enabledState, committedText: "你" });
    const bridge = {
      imeAvailable: true,
      imeKey: vi.fn(),
      imeAcquire: vi.fn().mockResolvedValue(lease(7)),
      imeRelease: vi.fn(),
      imeSelect,
      onImeCandidateAction: (listener: (action: ImeCandidateAction) => void) => {
        receiveAction = listener;
        return vi.fn();
      },
    } as unknown as DesktopBridge;
    const onCommit = vi.fn();
    const { result } = renderHook(() =>
      useEmbeddedIme(withSessionApi(bridge), onCommit, true, "composer"),
    );
    await act(async () => result.current.acquire());
    act(() => {
      receiveAction?.({
        type: "select",
        index: 0,
        targetId: "conversation-composer",
        generation: 6,
      });
      receiveAction?.({ type: "select", index: 0, targetId: "composer", generation: 7 });
    });
    expect(imeSelect).not.toHaveBeenCalled();
    act(() =>
      receiveAction?.({
        type: "select",
        index: 0,
        targetId: "conversation-composer",
        generation: 7,
      }),
    );
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("你"));
    expect(imeSelect).toHaveBeenCalledWith(0, 7);
  });

  it("keeps one active target per renderer and releases the previous lease on focus switch", async () => {
    const imeRelease = vi.fn().mockResolvedValue({ accepted: true, state: enabledState });
    const bridge = {
      imeAvailable: true,
      imeKey: vi.fn().mockResolvedValue(enabledState),
      imeAcquire: vi
        .fn()
        .mockResolvedValueOnce(
          lease(20, { ...enabledState, composing: false, preedit: "", candidates: [] }),
        )
        .mockResolvedValueOnce({
          ...lease(21, { ...enabledState, composing: false, preedit: "", candidates: [] }),
          targetId: "other",
        }),
      imeRelease,
    } as unknown as DesktopBridge;
    const typedBridge = withSessionApi(bridge);
    const first = renderHook(() => useEmbeddedIme(typedBridge, undefined, true, "composer"));
    const second = renderHook(() => useEmbeddedIme(typedBridge, undefined, true, "other"));
    await act(async () => first.result.current.acquire());
    await act(async () => second.result.current.acquire());
    await waitFor(() => expect(imeRelease).toHaveBeenCalledWith(20));
    const event = {
      key: "n",
      code: "KeyN",
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: false,
    } as never;
    expect(first.result.current.sendKey(event)).toBe(false);
    expect(second.result.current.sendKey(event)).toBe(true);
    first.unmount();
    second.unmount();
  });

  it("serializes key requests and ignores a reply after the lease is released", async () => {
    let resolveFirst: ((state: ImeState) => void) | undefined;
    const first = new Promise<ImeState>((resolve) => {
      resolveFirst = resolve;
    });
    const imeKey = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ ...enabledState, preedit: "ni" });
    const bridge = {
      imeAvailable: true,
      imeAcquire: vi
        .fn()
        .mockResolvedValue(
          lease(9, { ...enabledState, composing: false, preedit: "", candidates: [] }),
        ),
      imeRelease: vi.fn().mockResolvedValue(lease(9)),
      imeKey,
    } as unknown as DesktopBridge;
    const { result } = renderHook(() =>
      useEmbeddedIme(withSessionApi(bridge), undefined, true, "composer"),
    );
    await act(async () => result.current.acquire());
    const keyEvent = (key: string, code: string) =>
      ({ key, code, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }) as never;
    act(() => {
      result.current.sendKey(keyEvent("n", "KeyN"));
      result.current.sendKey(keyEvent("i", "KeyI"));
    });
    await waitFor(() => expect(imeKey).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.release();
    });
    await act(async () => {
      resolveFirst?.(enabledState);
      await first;
    });
    expect(result.current.state.preedit).toBe("");
    expect(imeKey).toHaveBeenCalledTimes(1);
  });

  it("queues keystrokes entered before the first lease acquisition resolves", async () => {
    let resolveAcquire: ((response: ImeLeaseResponse) => void) | undefined;
    const imeAcquire = vi.fn(
      () => new Promise<ImeLeaseResponse>((resolve) => (resolveAcquire = resolve)),
    );
    const imeKey = vi.fn().mockResolvedValue({ ...enabledState, preedit: "ni" });
    const bridge = {
      imeAvailable: true,
      imeAcquire,
      imeRelease: vi.fn(),
      imeKey,
    } as unknown as DesktopBridge;
    const { result } = renderHook(() =>
      useEmbeddedIme(withSessionApi(bridge), undefined, true, "composer"),
    );
    const keyEvent = (key: string, code: string) =>
      ({ key, code, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }) as never;

    act(() => {
      void result.current.acquire();
      expect(result.current.sendKey(keyEvent("n", "KeyN"))).toBe(true);
      expect(result.current.sendKey(keyEvent("i", "KeyI"))).toBe(true);
    });
    expect(imeKey).not.toHaveBeenCalled();
    await act(async () => {
      resolveAcquire?.(
        lease(12, { ...enabledState, composing: false, preedit: "", candidates: [] }),
      );
      await Promise.resolve();
    });
    await waitFor(() => expect(imeKey).toHaveBeenCalledTimes(2));
    expect(imeKey.mock.calls.map(([request]) => request.key)).toEqual(["n", "i"]);
  });

  it("follows a main-initiated revocation instead of trusting a renderer copy", async () => {
    const imeKey = vi.fn().mockResolvedValue(enabledState);
    const bridge = withSessionApi({
      imeAvailable: true,
      imeAcquire: vi
        .fn()
        .mockResolvedValue(
          lease(16, { ...enabledState, composing: false, preedit: "", candidates: [] }),
        ),
      imeRelease: vi.fn(),
      imeKey,
    } as unknown as DesktopBridge);
    const { result, unmount } = renderHook(() =>
      useEmbeddedIme(bridge, undefined, true, "composer"),
    );
    await act(async () => result.current.acquire());
    expect(result.current.generation).toBe(16);
    expect(result.current.targetEngaged).toBe(true);

    act(() =>
      publishImeSessionSnapshot({
        phase: "idle",
        engine: { ...enabledState, composing: false, preedit: "", candidates: [] },
        revision: 99,
      }),
    );

    expect(result.current.generation).toBeUndefined();
    expect(result.current.targetEngaged).toBe(false);
    expect(result.current.textPolicy.useNativeTextInput).toBe(true);
    expect(
      result.current.sendKey({
        key: "n",
        code: "KeyN",
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
      } as never),
    ).toBe(false);
    expect(imeKey).not.toHaveBeenCalled();
    unmount();
  });

  it("drops a queued key reply once the target is no longer registered", async () => {
    let resolveFirst: ((state: ImeState) => void) | undefined;
    const pending = new Promise<ImeState>((resolve) => {
      resolveFirst = resolve;
    });
    const onCommit = vi.fn();
    const imeKey = vi.fn().mockReturnValueOnce(pending);
    const bridge = withSessionApi({
      imeAvailable: true,
      imeAcquire: vi
        .fn()
        .mockResolvedValue(
          lease(17, { ...enabledState, composing: false, preedit: "", candidates: [] }),
        ),
      imeRelease: vi.fn(),
      imeKey,
    } as unknown as DesktopBridge);
    const { result, unmount } = renderHook(() =>
      useEmbeddedIme(bridge, onCommit, true, "composer"),
    );
    await act(async () => result.current.acquire());
    act(() =>
      result.current.sendKey({
        key: "n",
        code: "KeyN",
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
      } as never),
    );
    await waitFor(() => expect(imeKey).toHaveBeenCalledTimes(1));

    act(() => result.current.blur());
    await act(async () => {
      resolveFirst?.({ ...enabledState, committedText: "你" });
      await pending;
    });

    expect(onCommit).not.toHaveBeenCalled();
    expect(imeKey).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("keeps native input blocked for an owned lease after the editor loses DOM focus", async () => {
    const bridge = withSessionApi({
      imeAvailable: true,
      imeAcquire: vi.fn().mockResolvedValue(lease(18)),
      imeRelease: vi.fn(),
    } as unknown as DesktopBridge);
    const { result, unmount } = renderHook(() =>
      useEmbeddedIme(bridge, undefined, true, "composer"),
    );
    const input = document.createElement("textarea");
    input.dataset.imeTargetId = "composer";
    document.body.appendChild(input);
    input.focus();
    await act(async () => result.current.acquire());
    expect(result.current.textPolicy.useNativeTextInput).toBe(false);

    act(() => {
      input.blur();
      result.current.blur();
    });

    expect(result.current.generation).toBe(18);
    expect(result.current.targetEngaged).toBe(true);
    expect(result.current.textPolicy.useNativeTextInput).toBe(false);
    await act(async () => result.current.release("test"));
    unmount();
    input.remove();
  });
});

import type {
  DesktopBridge,
  ImeCandidateAction,
  ImeLeaseResponse,
  ImeSessionCommand,
  ImeSessionSnapshot,
  ImeState,
} from "@answra/shared";
import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useEmbeddedIme } from "../src/hooks/useEmbeddedIme";

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

function withSessionApi(legacyBridge: DesktopBridge): DesktopBridge {
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
        response = await legacyBridge.imeAcquire?.(command.targetId);
        const acquired = response as ImeLeaseResponse | undefined;
        if (acquired?.accepted && acquired.generation !== undefined) {
          state = acquired.state;
          owner = {
            windowId: 1,
            webContentsId: 1,
            targetId: acquired.targetId ?? command.targetId,
            generation: acquired.generation,
          };
          phase = "owned";
        }
      } else {
        switch (command.type) {
          case "releaseTarget":
            response = await legacyBridge.imeRelease?.(command.generation);
            phase = "idle";
            owner = undefined;
            break;
          case "resume":
            response = await legacyBridge.imeConfirmFocus?.(command.targetId, command.generation);
            phase = "owned";
            break;
          case "processKey":
            response = await legacyBridge.imeKey?.(command);
            break;
          case "setInputMode":
            response = await legacyBridge.imeSetInputMode?.(
              command.targetId,
              command.generation,
              command.inputMode,
            );
            break;
          case "cancelComposition":
            response = await legacyBridge.imeReset?.(command.generation);
            break;
          case "selectCandidate":
            response = await legacyBridge.imeSelect?.(command.index, command.generation);
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
      else if (!state.enabled && (command.type === "processKey" || command.type === "setInputMode"))
        state = { ...state, enabled: true };
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
  it("sends Shift keydown as a mode command and never forwards either edge to Rime keys", async () => {
    const imeKey = vi.fn();
    const imeSetInputMode = vi.fn().mockResolvedValue({ ...enabledState, inputMode: "ascii" });
    const bridge = {
      imeAvailable: true,
      imeKey,
      imeSetInputMode,
      imeAcquire: vi.fn().mockResolvedValue(lease(3, { ...enabledState, composing: false })),
      imeRelease: vi.fn(),
    } as unknown as DesktopBridge;
    const typedBridge = withSessionApi(bridge);
    const { result } = renderHook(() => useEmbeddedIme(typedBridge, undefined, true, "composer"));
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

    await waitFor(() => expect(imeSetInputMode).toHaveBeenCalledOnce());
    expect(imeSetInputMode).toHaveBeenCalledWith("composer", 3, "ascii");
    expect(typedBridge.imeSessionCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "setInputMode", targetId: "composer", inputMode: "ascii" }),
    );
    expect(imeKey).not.toHaveBeenCalled();
    input.remove();
  });

  it("serializes rapid Shift toggles against the latest authoritative mode", async () => {
    const modes: string[] = [];
    const bridge = withSessionApi({
      imeAvailable: true,
      imeAcquire: vi.fn().mockResolvedValue(lease(32, { ...enabledState, composing: false })),
      imeSetInputMode: vi.fn(async (_targetId, _generation, inputMode) => {
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
      expect(result.current.sendKey(shift as never)).toBe(true);
      expect(result.current.sendKey(shift as never)).toBe(true);
    });

    await waitFor(() => expect(modes).toEqual(["ascii", "chinese"]));
    expect(result.current.asciiMode).toBe(false);
    input.remove();
  });

  it("routes printable keys through the editor after Shift switches to ASCII", async () => {
    const imeKey = vi.fn();
    const imeSetInputMode = vi
      .fn()
      .mockResolvedValueOnce({ ...enabledState, composing: false, inputMode: "ascii" })
      .mockResolvedValueOnce({ ...enabledState, composing: false, inputMode: "chinese" });
    const bridge = {
      imeAvailable: true,
      imeKey,
      imeSetInputMode,
      imeAcquire: vi.fn().mockResolvedValue(lease(8, { ...enabledState, composing: false })),
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

    const shift = {
      key: "Shift",
      code: "ShiftLeft",
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: true,
      repeat: false,
    };
    act(() => expect(result.current.sendKey(shift as never)).toBe(true));
    await waitFor(() => expect(result.current.asciiMode).toBe(true));
    expect(imeSetInputMode).toHaveBeenCalledWith("composer", 8, "ascii");
    expect(imeKey).not.toHaveBeenCalled();

    const sentBeforeAsciiInput = imeKey.mock.calls.length;
    const asciiLetter = { ...shift, key: "a", code: "KeyA", shiftKey: false };
    act(() => expect(result.current.sendKey(asciiLetter as never)).toBe(false));
    expect(imeKey).toHaveBeenCalledTimes(sentBeforeAsciiInput);

    act(() => expect(result.current.sendKeyUp({ ...shift, shiftKey: false } as never)).toBe(true));
    act(() => expect(result.current.sendKey({ ...shift, repeat: false } as never)).toBe(true));
    await waitFor(() => expect(result.current.asciiMode).toBe(false));
    expect(imeSetInputMode).toHaveBeenCalledTimes(2);
    expect(imeKey).not.toHaveBeenCalled();
    input.remove();
  });

  it("synchronizes the authoritative mode snapshot across input targets", async () => {
    const bridge = withSessionApi({
      imeAvailable: true,
      imeAcquire: vi.fn().mockResolvedValue(lease(31, { ...enabledState, composing: false })),
      imeSetInputMode: vi.fn().mockResolvedValue({ ...enabledState, inputMode: "ascii" }),
      imeRelease: vi.fn(),
    } as unknown as DesktopBridge);
    const first = renderHook(() => useEmbeddedIme(bridge, undefined, true, "composer"));
    const second = renderHook(() => useEmbeddedIme(bridge, undefined, true, "settings-model"));
    const input = document.createElement("input");
    input.dataset.imeTargetId = "composer";
    document.body.appendChild(input);
    input.focus();
    await act(async () => first.result.current.acquire());

    act(() =>
      first.result.current.sendKey({
        key: "Shift",
        code: "ShiftLeft",
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: true,
        repeat: false,
      } as never),
    );

    await waitFor(() => expect(second.result.current.asciiMode).toBe(true));
    first.unmount();
    second.unmount();
    input.remove();
  });

  it("changes mode during composition without clearing, committing, or keying the composition", async () => {
    const imeKey = vi.fn();
    const imeReset = vi.fn().mockImplementation(async () => {
      return { ...enabledState, composing: false, preedit: "", candidates: [] };
    });
    const imeSetInputMode = vi.fn().mockResolvedValue({ ...enabledState, inputMode: "ascii" });
    const onCommit = vi.fn();
    const bridge = {
      imeAvailable: true,
      imeKey,
      imeReset,
      imeSetInputMode,
      imeAcquire: vi.fn().mockResolvedValue(lease(9)),
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
      result.current.sendKey({
        key: "Shift",
        code: "ShiftLeft",
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: true,
        repeat: false,
      } as never),
    );
    await waitFor(() => expect(imeSetInputMode).toHaveBeenCalledOnce());

    expect(imeSetInputMode).toHaveBeenCalledWith("composer", 9, "ascii");
    expect(imeReset).not.toHaveBeenCalled();
    expect(imeKey).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(result.current.asciiMode).toBe(true);
    expect(result.current.state).toMatchObject({ composing: true, preedit: "ni" });
    input.remove();
  });

  it("inserts unshifted digits directly when Chinese composition is inactive", async () => {
    const imeKey = vi.fn();
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

    expect(onCommit).toHaveBeenCalledWith("7");
    expect(imeKey).not.toHaveBeenCalled();
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
        accepted: true,
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
    unmount();
    await waitFor(() => expect(imeRelease).toHaveBeenCalledWith(2));
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
});

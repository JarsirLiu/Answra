import type { DesktopBridge, ImeCandidateAction, ImeLeaseResponse, ImeState } from "@answra/shared";
import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useEmbeddedIme } from "../src/hooks/useEmbeddedIme";

const enabledState: ImeState = {
  enabled: true,
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

describe("useEmbeddedIme lease routing", () => {
  it("forwards both Shift edges even without an active composition", async () => {
    const imeKey = vi.fn().mockResolvedValue({ ...enabledState, asciiMode: true });
    const bridge = {
      imeAvailable: true,
      imeKey,
      imeAcquire: vi.fn().mockResolvedValue(lease(3, { ...enabledState, composing: false })),
      imeRelease: vi.fn(),
    } as unknown as DesktopBridge;
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

    await waitFor(() => expect(imeKey).toHaveBeenCalledTimes(2));
    expect(imeKey).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ key: "Shift", release: false }),
    );
    expect(imeKey).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ key: "Shift", release: true }),
    );
    input.remove();
  });

  it("routes printable keys through the editor after Shift switches to ASCII", async () => {
    const imeKey = vi.fn().mockResolvedValue({ ...enabledState, composing: false });
    const bridge = {
      imeAvailable: true,
      imeKey,
      imeAcquire: vi.fn().mockResolvedValue(lease(8, { ...enabledState, composing: false })),
      imeRelease: vi.fn(),
    } as unknown as DesktopBridge;
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
    act(() => expect(result.current.sendKey(shift as never)).toBe(true));
    expect(result.current.asciiMode).toBe(true);
    await waitFor(() => expect(imeKey).toHaveBeenCalledTimes(1));

    const sentBeforeAsciiInput = imeKey.mock.calls.length;
    const asciiLetter = { ...shift, key: "a", code: "KeyA", shiftKey: false };
    act(() => expect(result.current.sendKey(asciiLetter as never)).toBe(false));
    expect(imeKey).toHaveBeenCalledTimes(sentBeforeAsciiInput);

    act(() => expect(result.current.sendKeyUp({ ...shift, shiftKey: false } as never)).toBe(true));
    act(() => expect(result.current.sendKey({ ...shift, repeat: false } as never)).toBe(true));
    expect(result.current.asciiMode).toBe(false);
    await waitFor(() => expect(imeKey).toHaveBeenCalledTimes(3));
    input.remove();
  });

  it("clears an unselected composition before toggling modes without committing it", async () => {
    const calls: string[] = [];
    const imeKey = vi.fn().mockImplementation(async () => {
      calls.push("key");
      return { ...enabledState, composing: false };
    });
    const imeReset = vi.fn().mockImplementation(async () => {
      calls.push("reset");
      return { ...enabledState, composing: false, preedit: "", candidates: [] };
    });
    const onCommit = vi.fn();
    const bridge = {
      imeAvailable: true,
      imeKey,
      imeReset,
      imeAcquire: vi.fn().mockResolvedValue(lease(9)),
      imeRelease: vi.fn(),
    } as unknown as DesktopBridge;
    const { result } = renderHook(() => useEmbeddedIme(bridge, onCommit, true, "composer"));
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
    await waitFor(() => expect(imeKey).toHaveBeenCalledOnce());

    expect(calls).toEqual(["reset", "key"]);
    expect(imeReset).toHaveBeenCalledWith(9);
    expect(onCommit).not.toHaveBeenCalled();
    expect(result.current.asciiMode).toBe(true);
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
    const { result } = renderHook(() => useEmbeddedIme(bridge, onCommit, true, "composer"));
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
    const { result } = renderHook(() => useEmbeddedIme(bridge, undefined, true, "composer"));
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
    const { result } = renderHook(() => useEmbeddedIme(bridge, undefined, true, "composer"));
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
    const { result } = renderHook(() => useEmbeddedIme(bridge, undefined, true, "composer"));
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
    const { result } = renderHook(() => useEmbeddedIme(bridge, undefined, true, "composer"));
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
    const { result, unmount } = renderHook(() => useEmbeddedIme(bridge));
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
    const { result } = renderHook(() => useEmbeddedIme(bridge, onCommit, true, "composer"));
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
    const first = renderHook(() => useEmbeddedIme(bridge, undefined, true, "composer"));
    const second = renderHook(() => useEmbeddedIme(bridge, undefined, true, "other"));
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
    const { result } = renderHook(() => useEmbeddedIme(bridge, undefined, true, "composer"));
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
    const { result } = renderHook(() => useEmbeddedIme(bridge, undefined, true, "composer"));
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

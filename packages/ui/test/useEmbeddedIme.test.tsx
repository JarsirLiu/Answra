import type { DesktopBridge, ImeCandidateAction, ImeState } from "@answra/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useEmbeddedIme } from "../src/hooks/useEmbeddedIme";

const emptyState: ImeState = {
  enabled: true,
  composing: true,
  preedit: "ni",
  candidates: [{ text: "你" }],
  selectedIndex: 0,
  page: 0,
  hasNextPage: false,
};

describe("useEmbeddedIme candidate routing", () => {
  it("reasserts Chinese mode when the application window regains focus", async () => {
    const imeEnable = vi.fn().mockResolvedValue(emptyState);
    const bridge = {
      imeAvailable: true,
      imeEnable,
      imeKey: vi.fn(),
      imeSelect: vi.fn(),
    } as unknown as DesktopBridge;
    const { unmount } = renderHook(() => useEmbeddedIme(bridge));

    await waitFor(() => expect(imeEnable).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(imeEnable).toHaveBeenCalledTimes(2));
    expect(imeEnable).toHaveBeenLastCalledWith(true);
    unmount();
  });

  it("does not disable the main-owned Rime session when its renderer hook unmounts", async () => {
    const imeEnable = vi.fn().mockResolvedValue(emptyState);
    const bridge = {
      imeAvailable: true,
      imeEnable,
      imeKey: vi.fn(),
      imeSelect: vi.fn(),
    } as unknown as DesktopBridge;
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;

    const { unmount } = renderHook(() => useEmbeddedIme(bridge), { wrapper });
    await waitFor(() => expect(imeEnable).toHaveBeenCalledWith(true));
    unmount();
    await new Promise((resolve) => window.setTimeout(resolve, 10));

    expect(imeEnable).not.toHaveBeenCalledWith(false);
  });

  it("commits text returned by a selection from the native candidate window", async () => {
    let receiveAction: ((action: ImeCandidateAction) => void) | undefined;
    const imeSelect = vi.fn().mockResolvedValue({
      ...emptyState,
      enabled: true,
      composing: false,
      preedit: "",
      candidates: [],
      committedText: "你",
    });
    const bridge = {
      imeAvailable: true,
      imeEnable: vi.fn().mockResolvedValue(emptyState),
      imeKey: vi.fn(),
      imeSelect,
      onImeCandidateAction: (listener: (action: ImeCandidateAction) => void) => {
        receiveAction = listener;
        return vi.fn();
      },
    } as unknown as DesktopBridge;
    const onCommit = vi.fn();
    renderHook(() => useEmbeddedIme(bridge, onCommit));

    await waitFor(() => expect(receiveAction).toBeTypeOf("function"));
    act(() => receiveAction?.({ type: "select", index: 0 }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("你"));
    expect(imeSelect).toHaveBeenCalledWith(0);
  });

  it("serializes physical key requests so stale replies cannot replace newer composition", async () => {
    let resolveFirst: ((state: ImeState) => void) | undefined;
    const first = new Promise<ImeState>((resolve) => {
      resolveFirst = resolve;
    });
    const imeKey = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({
        ...emptyState,
        preedit: "ni",
        candidates: [{ text: "你" }],
      });
    const bridge = {
      imeAvailable: true,
      imeEnable: vi.fn().mockResolvedValue(emptyState),
      imeKey,
      imeSelect: vi.fn(),
    } as unknown as DesktopBridge;
    const { result } = renderHook(() => useEmbeddedIme(bridge));

    await waitFor(() => expect(result.current.state.enabled).toBe(true));
    const keyEvent = (key: string, code: string) =>
      ({ key, code, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }) as never;
    act(() => {
      result.current.sendKey(keyEvent("n", "KeyN"));
      result.current.sendKey(keyEvent("i", "KeyI"));
    });

    await waitFor(() => expect(imeKey).toHaveBeenCalledTimes(1));
    await act(async () => {
      resolveFirst?.({ ...emptyState, preedit: "n", candidates: [{ text: "你" }] });
      await first;
    });
    await waitFor(() => expect(imeKey).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.state.preedit).toBe("ni"));
  });
});

import type { DesktopBridge, ImeState } from "@answra/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImeCandidateWindowApp } from "../src/app/ImeCandidateWindowApp";
import { deriveAmbientTokens } from "../src/hooks/useAmbientTheme";
import { AMBIENT_FOLLOW_STORAGE_KEY, APP_OPACITY_STORAGE_KEY } from "../src/model";

const state: ImeState = {
  enabled: true,
  inputMode: "chinese",
  composing: true,
  preedit: "ni",
  candidates: [{ text: "你" }, { text: "尼" }],
  selectedIndex: 0,
  page: 0,
  hasNextPage: true,
};

describe("ImeCandidateWindowApp", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    const root = document.documentElement;
    delete root.dataset.theme;
    root.style.removeProperty("--fade");
    root.style.removeProperty("--ink-tint");
    root.style.removeProperty("--panel-tint");
  });

  it("adopts the shared theme payload and opacity instead of stylesheet defaults", () => {
    localStorage.setItem(AMBIENT_FOLLOW_STORAGE_KEY, "on");
    localStorage.setItem(APP_OPACITY_STORAGE_KEY, "0.6");
    let emitAmbient:
      | ((payload: { ok: boolean; hex: string; luminance: number }) => void)
      | undefined;
    const bridge = {
      onImeCandidateState: () => () => {},
      requestImeCandidateState: vi.fn(),
      onAmbientColor: (
        listener: (payload: { ok: boolean; hex: string; luminance: number }) => void,
      ) => {
        emitAmbient = listener;
        return () => {};
      },
    } satisfies Partial<DesktopBridge>;
    render(<ImeCandidateWindowApp bridge={bridge as unknown as DesktopBridge} />);

    act(() => emitAmbient?.({ ok: true, hex: "#101418", luminance: 0.05 }));

    const derived = deriveAmbientTokens("#101418");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--ink-tint")).toBe(
      derived?.["--ink-tint"],
    );
    expect(document.documentElement.style.getPropertyValue("--panel-tint")).toBe(
      derived?.["--panel-tint"],
    );
    expect(document.documentElement.style.getPropertyValue("--fade")).toBe("0.6");
  });

  it("reports rendered candidate DOM and routes mouse selection to the input owner", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let receiveState:
      | ((next: { state: ImeState; targetId: string; generation: number }) => void)
      | undefined;
    const sendImeCandidateAction = vi.fn();
    const imeDiagnostic = vi.fn();
    const bridge = {
      onImeCandidateState: (listener) => {
        receiveState = listener;
        return vi.fn();
      },
      requestImeCandidateState: vi.fn(),
      sendImeCandidateAction,
      imeDiagnostic,
    } satisfies Partial<DesktopBridge>;
    render(<ImeCandidateWindowApp bridge={bridge as unknown as DesktopBridge} />);

    expect(bridge.requestImeCandidateState).toHaveBeenCalledOnce();
    act(() => receiveState?.({ state, targetId: "composer", generation: 3 }));
    expect(imeDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "candidate-rendered",
        targetId: "ime-candidate-window",
        ownerTargetId: "composer",
        generation: 3,
        preedit: "ni",
        candidates: state.candidates,
      }),
    );
    act(() => receiveState?.({ state, targetId: "composer", generation: 3 }));
    expect(
      imeDiagnostic.mock.calls.filter(([value]) => value.event === "candidate-rendered"),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("option", { name: /尼/ }));

    expect(sendImeCandidateAction).toHaveBeenCalledWith({
      type: "select",
      index: 1,
      targetId: "composer",
      generation: 3,
    });
  });

  it("reports unclipped content size so a shrunk candidate window can grow back", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let receiveState:
      | ((next: { state: ImeState; targetId: string; generation: number }) => void)
      | undefined;
    const fitImeCandidate = vi.fn();
    const bridge = {
      onImeCandidateState: (listener) => {
        receiveState = listener;
        return vi.fn();
      },
      requestImeCandidateState: vi.fn(),
      fitImeCandidate,
    } satisfies Partial<DesktopBridge>;
    const { container } = render(
      <ImeCandidateWindowApp bridge={bridge as unknown as DesktopBridge} />,
    );
    const root = container.firstChild as HTMLElement;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 160,
      height: 52,
      top: 0,
      left: 0,
      right: 160,
      bottom: 52,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(root, "scrollWidth", { configurable: true, value: 472 });
    Object.defineProperty(root, "scrollHeight", { configurable: true, value: 72 });

    act(() => receiveState?.({ state, targetId: "composer", generation: 1 }));

    expect(fitImeCandidate).toHaveBeenCalledWith({ width: 472, height: 72 });
  });
});

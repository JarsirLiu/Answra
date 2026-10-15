import type { DesktopBridge, ImeState } from "@answra/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImeCandidateWindowApp } from "../src/app/ImeCandidateWindowApp";

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
  afterEach(() => vi.unstubAllGlobals());

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
});

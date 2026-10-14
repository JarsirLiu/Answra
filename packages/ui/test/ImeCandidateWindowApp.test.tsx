import type { DesktopBridge, ImeState } from "@answra/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImeCandidateWindowApp } from "../src/app/ImeCandidateWindowApp";

const state: ImeState = {
  enabled: true,
  composing: true,
  preedit: "ni",
  candidates: [{ text: "你" }, { text: "尼" }],
  selectedIndex: 0,
  page: 0,
  hasNextPage: true,
};

describe("ImeCandidateWindowApp", () => {
  it("requests state and routes mouse selection back to the input owner", () => {
    let receiveState: ((next: ImeState) => void) | undefined;
    const sendImeCandidateAction = vi.fn();
    const bridge = {
      onImeCandidateState: (listener) => {
        receiveState = listener;
        return vi.fn();
      },
      requestImeCandidateState: vi.fn(),
      sendImeCandidateAction,
    } satisfies Partial<DesktopBridge>;
    render(<ImeCandidateWindowApp bridge={bridge as unknown as DesktopBridge} />);

    expect(bridge.requestImeCandidateState).toHaveBeenCalledOnce();
    act(() => receiveState?.(state));
    fireEvent.click(screen.getByRole("option", { name: /尼/ }));

    expect(sendImeCandidateAction).toHaveBeenCalledWith({ type: "select", index: 1 });
  });
});

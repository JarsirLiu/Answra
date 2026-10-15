import type { ImeState } from "@answra/shared";
import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImeCandidateAnchorReporter } from "../src/components/panels/ImeCandidateAnchorReporter";

const state: ImeState = {
  enabled: true,
  composing: true,
  preedit: "nihao",
  candidates: [{ text: "你好" }, { text: "拟好" }],
  selectedIndex: 0,
  page: 0,
  hasNextPage: true,
};

function mountHost() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const textarea = document.createElement("textarea");
  textarea.readOnly = true;
  textarea.dataset.imePolicy = "text";
  textarea.dataset.imeTargetId = "composer";
  textarea.value = state.preedit;
  textarea.setSelectionRange(state.preedit.length, state.preedit.length);
  return { host, textarea };
}

describe("ImeCandidateAnchorReporter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports textarea caret geometry without rendering popup content in the input window", () => {
    const onUpdate = vi.fn();
    const { host, textarea } = mountHost();
    const { container } = render(
      <ImeCandidateAnchorReporter
        onUpdate={onUpdate}
        state={state}
        targetId="composer"
        generation={2}
      />,
      {
        container: host,
      },
    );
    host.appendChild(textarea);
    fireEvent.focusIn(textarea);

    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(onUpdate).toHaveBeenLastCalledWith({
      type: "show",
      state,
      anchor: { x: 0, lineTop: 0, lineBottom: 0 },
      targetId: "composer",
      generation: 2,
    });
  });

  it("anchors candidates at the beginning of the preedit at the current selection", () => {
    const onUpdate = vi.fn();
    const { host, textarea } = mountHost();
    textarea.value = "abcnihaoz";
    textarea.setSelectionRange(8, 8);
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockReturnValue(6);
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(3);
    vi.spyOn(textarea, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 40,
      left: 100,
      top: 40,
      right: 300,
      bottom: 70,
      width: 200,
      height: 30,
      toJSON: () => ({}),
    });
    render(
      <ImeCandidateAnchorReporter
        onUpdate={onUpdate}
        state={state}
        targetId="composer"
        generation={2}
      />,
      { container: host },
    );
    host.appendChild(textarea);
    fireEvent.focusIn(textarea);

    expect(onUpdate).toHaveBeenLastCalledWith({
      type: "show",
      state,
      anchor: { x: 106, lineTop: 43, lineBottom: 43 },
      targetId: "composer",
      generation: 2,
    });
  });

  it("keeps the candidate anchor through DOM blur while composition is active", () => {
    const onUpdate = vi.fn();
    const { host, textarea } = mountHost();
    render(
      <ImeCandidateAnchorReporter
        onUpdate={onUpdate}
        state={state}
        targetId="composer"
        generation={2}
      />,
      { container: host },
    );
    host.appendChild(textarea);
    fireEvent.focusIn(textarea);
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    fireEvent.focusOut(textarea);

    expect(onUpdate).toHaveBeenLastCalledWith({
      type: "show",
      state,
      anchor: { x: 0, lineTop: 0, lineBottom: 0 },
      targetId: "composer",
      generation: 2,
    });
    hasFocus.mockRestore();
  });

  it("does not publish candidates while the engine is disabled", () => {
    const onUpdate = vi.fn();
    const { host, textarea } = mountHost();
    render(
      <ImeCandidateAnchorReporter
        onUpdate={onUpdate}
        state={{ ...state, enabled: false }}
        targetId="composer"
        generation={2}
      />,
      { container: host },
    );
    host.appendChild(textarea);
    fireEvent.focusIn(textarea);

    expect(onUpdate).toHaveBeenLastCalledWith({
      type: "clear",
      state: { ...state, enabled: false },
      targetId: "composer",
      generation: 2,
    });
  });

  it("preserves the current candidate surface while composition is active but candidates are transiently empty", () => {
    const onUpdate = vi.fn();
    const { host, textarea } = mountHost();
    render(
      <ImeCandidateAnchorReporter
        onUpdate={onUpdate}
        state={{ ...state, preedit: "", candidates: [] }}
        targetId="composer"
        generation={2}
      />,
      { container: host },
    );
    host.appendChild(textarea);
    fireEvent.focusIn(textarea);

    expect(onUpdate).not.toHaveBeenCalledWith({ type: "suspend" });
    expect(onUpdate).not.toHaveBeenCalledWith({
      type: "clear",
      state: { ...state, preedit: "", candidates: [] },
    });
  });

  it("waits for a textarea anchor instead of suspending an active composition", () => {
    const onUpdate = vi.fn();
    const { host, textarea } = mountHost();
    render(
      <ImeCandidateAnchorReporter
        onUpdate={onUpdate}
        state={state}
        targetId="composer"
        generation={2}
      />,
      { container: host },
    );

    expect(onUpdate).not.toHaveBeenCalledWith({ type: "suspend" });
    expect(onUpdate).not.toHaveBeenCalledWith({ type: "clear", state });

    host.appendChild(textarea);
    fireEvent.focusIn(textarea);

    expect(onUpdate).toHaveBeenLastCalledWith({
      type: "show",
      state,
      anchor: { x: 0, lineTop: 0, lineBottom: 0 },
      targetId: "composer",
      generation: 2,
    });
  });

  it("preserves and restores the last IME textarea across window focus changes", () => {
    const onUpdate = vi.fn();
    const { host, textarea } = mountHost();
    render(
      <ImeCandidateAnchorReporter
        onUpdate={onUpdate}
        state={state}
        targetId="composer"
        generation={2}
      />,
      { container: host },
    );
    host.appendChild(textarea);
    fireEvent.focusIn(textarea);
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    fireEvent.focusOut(textarea);
    expect(onUpdate).toHaveBeenLastCalledWith({
      type: "show",
      state,
      anchor: { x: 0, lineTop: 0, lineBottom: 0 },
      targetId: "composer",
      generation: 2,
    });

    fireEvent.focus(window);

    expect(document.activeElement).toBe(textarea);
    expect(onUpdate).toHaveBeenLastCalledWith({
      type: "show",
      state,
      anchor: { x: 0, lineTop: 0, lineBottom: 0 },
      targetId: "composer",
      generation: 2,
    });
    hasFocus.mockRestore();
  });
});

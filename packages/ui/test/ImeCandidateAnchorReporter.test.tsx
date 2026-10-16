import type { ImeState } from "@answra/shared";
import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImeCandidateAnchorReporter } from "../src/components/panels/ImeCandidateAnchorReporter";

const state: ImeState = {
  enabled: true,
  inputMode: "chinese",
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
      anchor: { x: 0, lineTop: 0, lineBottom: 0 },
      targetId: "composer",
      generation: 2,
    });
  });

  it("anchors candidates at the editor selection without preedit offset correction", () => {
    const onUpdate = vi.fn();
    const { host, textarea } = mountHost();
    textarea.value = "abcxyz";
    textarea.setSelectionRange(3, 3);
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
      anchor: { x: 106, lineTop: 43, lineBottom: 43 },
      targetId: "composer",
      generation: 2,
    });
  });

  it("keeps the candidate anchor through DOM blur while composition is active", () => {
    const onUpdate = vi.fn();
    const { host, textarea } = mountHost();
    const wrapper = document.createElement("div");
    wrapper.className = "conversation-composer-editor";
    wrapper.dataset.imeCompositionTarget = "composer";
    wrapper.dataset.imeCompositionProjection = "true";
    const marker = document.createElement("span");
    marker.dataset.imeCompositionCaret = "true";
    vi.spyOn(marker, "getBoundingClientRect").mockReturnValue({
      x: 164,
      y: 92,
      left: 164,
      top: 92,
      right: 165,
      bottom: 110,
      width: 1,
      height: 18,
      toJSON: () => ({}),
    });
    wrapper.append(textarea, marker);
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

    expect(onUpdate).toHaveBeenCalledWith({
      type: "clear",
      targetId: "composer",
      generation: 2,
    });
  });

  it("clears the candidate surface while composition is active but has no candidates", () => {
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

    expect(onUpdate).toHaveBeenLastCalledWith({
      type: "clear",
      targetId: "composer",
      generation: 2,
    });
  });

  it("anchors candidates to the rendered composition caret marker", () => {
    const onUpdate = vi.fn();
    const { host, textarea } = mountHost();
    const wrapper = document.createElement("div");
    wrapper.className = "conversation-composer-editor";
    wrapper.dataset.imeCompositionTarget = "composer";
    wrapper.dataset.imeCompositionProjection = "true";
    const marker = document.createElement("span");
    marker.dataset.imeCompositionCaret = "true";
    vi.spyOn(marker, "getBoundingClientRect").mockReturnValue({
      x: 164,
      y: 92,
      left: 164,
      top: 92,
      right: 165,
      bottom: 110,
      width: 1,
      height: 18,
      toJSON: () => ({}),
    });
    wrapper.append(textarea, marker);
    render(
      <ImeCandidateAnchorReporter
        onUpdate={onUpdate}
        state={state}
        targetId="composer"
        generation={2}
      />,
      { container: host },
    );
    host.appendChild(wrapper);
    fireEvent.focusIn(textarea);

    expect(onUpdate).toHaveBeenLastCalledWith({
      type: "show",
      anchor: { x: 164, lineTop: 92, lineBottom: 110 },
      targetId: "composer",
      generation: 2,
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
    expect(onUpdate).not.toHaveBeenCalledWith({ type: "clear", targetId: "composer" });

    host.appendChild(textarea);
    fireEvent.focusIn(textarea);

    expect(onUpdate).toHaveBeenLastCalledWith({
      type: "show",
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
      anchor: { x: 0, lineTop: 0, lineBottom: 0 },
      targetId: "composer",
      generation: 2,
    });

    fireEvent.focus(window);

    expect(document.activeElement).toBe(textarea);
    expect(onUpdate).toHaveBeenLastCalledWith({
      type: "show",
      anchor: { x: 0, lineTop: 0, lineBottom: 0 },
      targetId: "composer",
      generation: 2,
    });
    hasFocus.mockRestore();
  });
});

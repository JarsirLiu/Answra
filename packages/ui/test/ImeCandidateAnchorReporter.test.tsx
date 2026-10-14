import type { ImeState } from "@answra/shared";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
  textarea.dataset.embeddedImeTarget = "true";
  return { host, textarea };
}

describe("ImeCandidateAnchorReporter", () => {
  it("reports caret geometry without rendering popup content in the input window", () => {
    const onUpdate = vi.fn();
    const { host, textarea } = mountHost();
    const { container } = render(<ImeCandidateAnchorReporter onUpdate={onUpdate} state={state} />, {
      container: host,
    });
    host.appendChild(textarea);
    fireEvent.focusIn(textarea);

    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(onUpdate).toHaveBeenLastCalledWith({
      state,
      anchor: { x: 0, lineTop: 0, lineBottom: 0 },
    });
  });

  it("anchors the native candidate window at the start of the active preedit", () => {
    const onUpdate = vi.fn();
    const { host, textarea } = mountHost();
    textarea.value = "draft nihao";
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    vi.spyOn(textarea, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 50,
      left: 100,
      top: 50,
      right: 300,
      bottom: 90,
      width: 200,
      height: 40,
      toJSON: () => ({}),
    });
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this instanceof HTMLSpanElement ? (this.previousSibling?.textContent?.length ?? 0) : 0;
    });
    render(<ImeCandidateAnchorReporter onUpdate={onUpdate} state={state} />, { container: host });
    host.appendChild(textarea);
    fireEvent.focusIn(textarea);

    expect(onUpdate).toHaveBeenLastCalledWith({
      state,
      anchor: { x: 106, lineTop: 50, lineBottom: 50 },
    });
  });

  it("clears the native candidate window when focus leaves the IME target", () => {
    const onUpdate = vi.fn();
    const { host, textarea } = mountHost();
    render(<ImeCandidateAnchorReporter onUpdate={onUpdate} state={state} />, { container: host });
    host.appendChild(textarea);
    fireEvent.focusIn(textarea);
    fireEvent.focusOut(textarea);

    expect(onUpdate).toHaveBeenLastCalledWith(null);
  });

  it("does not publish candidates while the engine is disabled", () => {
    const onUpdate = vi.fn();
    const { host, textarea } = mountHost();
    render(
      <ImeCandidateAnchorReporter onUpdate={onUpdate} state={{ ...state, enabled: false }} />,
      {
        container: host,
      },
    );
    host.appendChild(textarea);
    fireEvent.focusIn(textarea);

    expect(onUpdate).toHaveBeenLastCalledWith(null);
  });
});

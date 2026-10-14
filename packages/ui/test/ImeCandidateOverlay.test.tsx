import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImeCandidateOverlay } from "../src/components/panels/ImeCandidateOverlay";
import type { ImeState } from "@answra/shared";

const state: ImeState = {
  enabled: true,
  composing: true,
  preedit: "nihao",
  candidates: [{ text: "你好" }, { text: "拟好" }],
  selectedIndex: 0,
  page: 0,
  hasNextPage: true,
};

/**
 * React 挂载时会清空 container 既有子节点，输入框必须在 render 之后再挂进
 * document，否则 focusin 事件无法冒泡到 document 上的监听器。
 */
function mountHost() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const textarea = document.createElement("textarea");
  textarea.dataset.embeddedImeTarget = "true";
  return { host, textarea };
}

function attach(host: HTMLElement, textarea: HTMLTextAreaElement) {
  host.appendChild(textarea);
}

describe("ImeCandidateOverlay", () => {
  afterEach(() => {
    // 只清理手动创建的 textarea；portal 节点由 RTL cleanup 卸载，手动移除会破坏 React 的子节点记录。
    document
      .querySelectorAll("[data-embedded-ime-target]")
      .forEach((node) => node.remove());
  });

  it("renders the candidate window as a floating layer outside the panel host", () => {
    const { host, textarea } = mountHost();
    const { container } = render(
      <ImeCandidateOverlay onNavigate={vi.fn()} onSelect={vi.fn()} state={state} />,
      { container: host },
    );
    attach(host, textarea);
    textarea.focus();
    fireEvent.focusIn(textarea);

    const popup = screen.getByRole("listbox");
    expect(container.contains(popup)).toBe(false);
    expect(document.body.contains(popup)).toBe(true);
  });

  it("stays mounted and keeps the overlay when a candidate button is pressed", () => {
    const onSelect = vi.fn();
    const { host, textarea } = mountHost();
    render(<ImeCandidateOverlay onNavigate={vi.fn()} onSelect={onSelect} state={state} />, {
      container: host,
    });
    attach(host, textarea);
    textarea.focus();
    fireEvent.focusIn(textarea);
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    // mousedown 阻止默认行为后浮层不消失，点击仍能上屏候选。
    fireEvent.mouseDown(screen.getByRole("option", { name: /拟好/ }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: /拟好/ }));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("hides when focus leaves the ime target", () => {
    const { host, textarea } = mountHost();
    render(<ImeCandidateOverlay onNavigate={vi.fn()} onSelect={vi.fn()} state={state} />, {
      container: host,
    });
    attach(host, textarea);
    textarea.focus();
    fireEvent.focusIn(textarea);
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.focusOut(textarea);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("stays hidden while the ime engine reports disabled", () => {
    const { host, textarea } = mountHost();
    render(
      <ImeCandidateOverlay
        onNavigate={vi.fn()}
        onSelect={vi.fn()}
        state={{ ...state, enabled: false }}
      />,
      { container: host },
    );
    attach(host, textarea);
    fireEvent.focusIn(textarea);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

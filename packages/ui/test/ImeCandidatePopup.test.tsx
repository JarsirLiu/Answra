import type { ImeState } from "@answra/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImeCandidatePopup } from "../src/components/panels/ImeCandidatePopup";

const state: ImeState = {
  enabled: true,
  composing: true,
  preedit: "nihao",
  candidates: [{ text: "你好", comment: "常用" }, { text: "拟好" }],
  selectedIndex: 0,
  page: 0,
  hasNextPage: true,
};

describe("ImeCandidatePopup", () => {
  it("renders preedit and candidates and reports selection", () => {
    const onSelect = vi.fn();
    render(<ImeCandidatePopup onNavigate={vi.fn()} onSelect={onSelect} state={state} />);

    expect(screen.getByText("nihao")).toBeInTheDocument();
    expect(screen.getByText("你好")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /拟好/ }));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("routes candidate movement and paging controls to the IME engine", () => {
    const onNavigate = vi.fn();
    render(
      <ImeCandidatePopup
        onNavigate={onNavigate}
        onSelect={vi.fn()}
        state={{ ...state, page: 1 }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "向左选择候选词" }));
    fireEvent.click(screen.getByRole("button", { name: "向右选择候选词" }));
    fireEvent.click(screen.getByRole("button", { name: "上翻候选页" }));
    fireEvent.click(screen.getByRole("button", { name: "下翻候选页" }));
    expect(onNavigate.mock.calls).toEqual([
      ["ArrowLeft"],
      ["ArrowRight"],
      ["PageUp"],
      ["PageDown"],
    ]);
  });

  it("stays hidden without composition state", () => {
    render(
      <ImeCandidatePopup
        onNavigate={vi.fn()}
        onSelect={vi.fn()}
        state={{ ...state, enabled: false }}
      />,
    );
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

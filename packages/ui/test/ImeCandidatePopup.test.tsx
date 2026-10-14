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
  it("renders candidates with windows-style paging and reports selection", () => {
    const onSelect = vi.fn();
    render(<ImeCandidatePopup onNavigate={vi.fn()} onSelect={onSelect} state={state} />);

    expect(screen.getByText("你好")).toBeInTheDocument();
    expect(screen.getByText("拟好")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /拟好/ }));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("does not render the preedit row; pinyin lives inside the input", () => {
    render(<ImeCandidatePopup onNavigate={vi.fn()} onSelect={vi.fn()} state={state} />);
    expect(screen.queryByText("nihao")).not.toBeInTheDocument();
  });

  it("routes paging controls to the IME engine", () => {
    const onNavigate = vi.fn();
    render(
      <ImeCandidatePopup
        onNavigate={onNavigate}
        onSelect={vi.fn()}
        state={{ ...state, page: 1 }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "上一页候选" }));
    fireEvent.click(screen.getByRole("button", { name: "下一页候选" }));
    expect(onNavigate.mock.calls).toEqual([["PageUp"], ["PageDown"]]);
  });

  it("keeps both paging controls visible when a direction is unavailable", () => {
    render(
      <ImeCandidatePopup
        onNavigate={vi.fn()}
        onSelect={vi.fn()}
        state={{ ...state, page: 0, hasNextPage: false }}
      />,
    );

    expect(screen.getByRole("button", { name: "上一页候选" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下一页候选" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下一页候选" })).toHaveAttribute(
      "title",
      "下一页候选",
    );
  });

  it("shows the preedit inline when no candidates are available", () => {
    render(
      <ImeCandidatePopup
        onNavigate={vi.fn()}
        onSelect={vi.fn()}
        state={{ ...state, candidates: [], hasNextPage: false }}
      />,
    );
    expect(screen.getByText("nihao")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
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

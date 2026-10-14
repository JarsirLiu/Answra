import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationComposer } from "../src/components/panels/ConversationComposer";

describe("ConversationComposer", () => {
  it("keeps editing, attachment and Enter submit callbacks available", () => {
    const onValueChange = vi.fn();
    const onAddAttachment = vi.fn();
    const onSubmit = vi.fn();
    render(
      <ConversationComposer
        inputLabel="补充问题"
        onAddAttachment={onAddAttachment}
        onSubmit={onSubmit}
        onValueChange={onValueChange}
        placeholder="输入问题"
        value=""
      />,
    );

    const input = screen.getByRole("textbox", { name: "补充问题" });
    fireEvent.change(input, { target: { value: "解释这道题" } });
    expect(onValueChange).toHaveBeenCalledWith("解释这道题");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    expect(onSubmit).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "添加附件" }));
    expect(onAddAttachment).toHaveBeenCalledOnce();
  });

  it("keeps the textarea blocked when embedded IME is disabled", () => {
    const onValueChange = vi.fn();
    const onToggle = vi.fn();
    render(
      <ConversationComposer
        inputLabel="补充问题"
        ime={{
          active: false,
          available: true,
          imeEnabled: false,
          onKeyDown: vi.fn(() => false),
          onNavigate: vi.fn(),
          onSelect: vi.fn(),
          onToggle,
          state: {
            enabled: false,
            composing: false,
            preedit: "",
            candidates: [],
            selectedIndex: 0,
            page: 0,
            hasNextPage: false,
          },
        }}
        onValueChange={onValueChange}
        placeholder="输入问题"
        value=""
      />,
    );

    const input = screen.getByRole("textbox", { name: "补充问题" });
    expect(input).toHaveAttribute("readonly");
    fireEvent.change(input, { target: { value: "plain text" } });
    expect(onValueChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "启用内置输入法" }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("keeps focus available but blocks native text insertion while embedded IME is active", () => {
    const onValueChange = vi.fn();
    const onKeyDown = vi.fn(() => true);
    render(
      <ConversationComposer
        inputLabel="补充问题"
        ime={{
          active: true,
          available: true,
          imeEnabled: true,
          onKeyDown,
          onNavigate: vi.fn(),
          onSelect: vi.fn(),
          onToggle: vi.fn(),
          state: {
            enabled: true,
            composing: false,
            preedit: "",
            candidates: [],
            selectedIndex: 0,
            page: 0,
            hasNextPage: false,
          },
        }}
        onValueChange={onValueChange}
        placeholder="输入问题"
        value=""
      />,
    );

    const input = screen.getByRole("textbox", { name: "补充问题" });
    expect(input).toHaveAttribute("readonly");
    expect(input).not.toBeDisabled();
    fireEvent.keyDown(input, { key: "Process", code: "KeyN" });
    expect(onKeyDown).toHaveBeenCalledOnce();
    fireEvent.change(input, { target: { value: "native composition" } });
    expect(onValueChange).not.toHaveBeenCalled();
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationComposer } from "../src/components/panels/ConversationComposer";

const EMPTY_IME_STATE = {
  enabled: false,
  composing: false,
  preedit: "",
  candidates: [],
  selectedIndex: 0,
  page: 0,
  hasNextPage: false,
};

function imeProps(
  overrides: Partial<NonNullable<React.ComponentProps<typeof ConversationComposer>["ime"]>> = {},
) {
  return {
    active: true,
    available: true,
    imeEnabled: true,
    onKeyDown: vi.fn(() => true),
    onSelect: vi.fn(),
    onNavigate: vi.fn(),
    onCandidateUpdate: vi.fn(),
    onToggle: vi.fn(),
    state: EMPTY_IME_STATE,
    ...overrides,
  };
}

describe("ConversationComposer", () => {
  it("keeps normal editing, paste and Enter submit callbacks available", () => {
    const onValueChange = vi.fn();
    const onPasteImages = vi.fn();
    const onAddAttachment = vi.fn();
    const onSubmit = vi.fn();
    render(
      <ConversationComposer
        inputLabel="补充问题"
        onAddAttachment={onAddAttachment}
        onPasteImages={onPasteImages}
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

    const file = new File(["png"], "shot.png", { type: "image/png" });
    fireEvent.paste(input, { clipboardData: { files: [file] } });
    expect(onPasteImages).toHaveBeenCalledWith([file]);
  });

  it("uses a focused read-only textarea while the embedded IME owns input", () => {
    const onKeyDown = vi.fn(() => true);
    const onToggle = vi.fn();
    render(
      <ConversationComposer
        ime={imeProps({ onKeyDown, onToggle })}
        inputLabel="补充问题"
        onValueChange={vi.fn()}
        placeholder="输入问题"
        value=""
      />,
    );

    const input = screen.getByRole("textbox", { name: "补充问题" }) as HTMLTextAreaElement;
    expect(input).toHaveProperty("readOnly", true);
    expect(input).toHaveAttribute("data-embedded-ime-target", "true");
    expect(input).not.toHaveAttribute("contenteditable");
    fireEvent.keyDown(input, { key: "Process", code: "KeyN" });
    expect(onKeyDown).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "关闭内置输入法" }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("renders Rime preedit at the current textarea selection", () => {
    const props = imeProps({
      state: { ...EMPTY_IME_STATE, enabled: true, composing: true, preedit: "n" },
    });
    const onKeyDown = vi.fn(() => true);
    const { rerender } = render(
      <ConversationComposer
        ime={imeProps({ active: true, onKeyDown })}
        inputLabel="补充问题"
        placeholder="输入问题"
        value="abcd"
      />,
    );
    const input = screen.getByRole("textbox", { name: "补充问题" }) as HTMLTextAreaElement;
    input.setSelectionRange(2, 2);
    fireEvent.keyDown(input, { key: "n", code: "KeyN" });

    rerender(
      <ConversationComposer
        ime={props}
        inputLabel="补充问题"
        placeholder="输入问题"
        value="abcd"
      />,
    );
    expect(input.value).toBe("abncd");
    expect(input.selectionStart).toBe(3);
    expect(document.activeElement).toBe(input);
  });
});

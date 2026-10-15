import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationComposer } from "../src/components/panels/ConversationComposer";
import { resolveImeTextPolicy, shouldPreventImeBeforeInput } from "../src/ime/imeTextPolicy";

const EMPTY_IME_STATE = {
  enabled: false,
  inputMode: "chinese" as const,
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
    textPolicy: resolveImeTextPolicy({
      targetOwned: true,
      inputMode: "chinese",
      composing: false,
    }),
    shouldPreventBeforeInput: (inputType: string) =>
      shouldPreventImeBeforeInput(
        resolveImeTextPolicy({
          targetOwned: true,
          inputMode: "chinese",
          composing: false,
        }),
        inputType,
      ),
    onKeyDown: vi.fn(() => true),
    onSelect: vi.fn(),
    onNavigate: vi.fn(),
    onCandidateUpdate: vi.fn(),
    onFocus: vi.fn(),
    onBlur: vi.fn(),
    targetId: "test-composer",
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

  it("keeps the textarea read-only while the embedded IME owns input", async () => {
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
    input.focus();
    await waitFor(() =>
      expect(document.querySelector("[data-ime-visual-caret='true']")).not.toBeNull(),
    );
    fireEvent.keyDown(input, { key: "Process", code: "KeyN" });
    expect(onKeyDown).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "关闭内置输入法" }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("restores ordinary text editing when the embedded IME is disabled", () => {
    const onValueChange = vi.fn();
    render(
      <ConversationComposer
        ime={imeProps({
          active: false,
          imeEnabled: false,
          textPolicy: resolveImeTextPolicy({
            targetOwned: false,
            inputMode: "chinese",
            composing: false,
          }),
          shouldPreventBeforeInput: (inputType) =>
            shouldPreventImeBeforeInput(
              resolveImeTextPolicy({
                targetOwned: false,
                inputMode: "chinese",
                composing: false,
              }),
              inputType,
            ),
        })}
        inputLabel="补充问题"
        onValueChange={onValueChange}
        placeholder="输入问题"
        value=""
      />,
    );

    const input = screen.getByRole("textbox", { name: "补充问题" });
    expect(input).toHaveProperty("readOnly", false);
    fireEvent.change(input, { target: { value: "hello" } });
    expect(onValueChange).toHaveBeenCalledWith("hello");
  });

  it("keeps ASCII text and Backspace native while blocking platform composition", () => {
    const onValueChange = vi.fn();
    const onKeyDown = vi.fn(() => false);
    render(
      <ConversationComposer
        ime={imeProps({
          onKeyDown,
          textPolicy: resolveImeTextPolicy({
            targetOwned: true,
            inputMode: "ascii",
            composing: false,
          }),
        })}
        inputLabel="补充问题"
        onValueChange={onValueChange}
        placeholder="输入问题"
        value="text"
      />,
    );

    const input = screen.getByRole("textbox", { name: "补充问题" });
    expect(input).toHaveProperty("readOnly", false);
    fireEvent.change(input, { target: { value: "text!" } });
    expect(onValueChange).toHaveBeenCalledWith("text!");
    fireEvent.keyDown(input, { key: "Backspace", code: "Backspace" });
    expect(onKeyDown).toHaveBeenCalledOnce();
    const compositionStart = new CompositionEvent("compositionstart", {
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(compositionStart);
    expect(compositionStart.defaultPrevented).toBe(true);
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

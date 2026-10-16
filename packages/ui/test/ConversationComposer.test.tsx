import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationComposer } from "../src/components/panels/ConversationComposer";
import type { ImeEditorCommand } from "../src/ime/imeKeyRouter";
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
      composing: false,
    }),
    shouldPreventBeforeInput: (inputType: string) =>
      shouldPreventImeBeforeInput(
        resolveImeTextPolicy({
          targetOwned: true,
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
    generation: 1,
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

  it("lets editor adapter commands update draft while native textarea editing is blocked", () => {
    const onValueChange = vi.fn();
    const onKeyDown = vi.fn(
      (
        _event: React.KeyboardEvent<HTMLTextAreaElement>,
        applyEditorCommand: (command: ImeEditorCommand) => void,
      ) => {
        applyEditorCommand({ type: "deleteBackward" });
        return true;
      },
    );
    render(
      <ConversationComposer
        ime={imeProps({ onKeyDown })}
        inputLabel="补充问题"
        onValueChange={onValueChange}
        placeholder="输入问题"
        value="ab"
      />,
    );

    const input = screen.getByRole("textbox", { name: "补充问题" }) as HTMLTextAreaElement;
    input.setSelectionRange(1, 1);
    expect(input.readOnly).toBe(true);
    fireEvent.keyDown(input, { key: "Backspace", code: "Backspace" });

    expect(onValueChange).toHaveBeenCalledWith("b");
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
            composing: false,
          }),
          shouldPreventBeforeInput: (inputType) =>
            shouldPreventImeBeforeInput(
              resolveImeTextPolicy({
                targetOwned: false,
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

  it("keeps the owned target read-only in ASCII mode so the platform IME stays out", () => {
    const onValueChange = vi.fn();
    const onKeyDown = vi.fn(() => false);
    render(
      <ConversationComposer
        ime={imeProps({ onKeyDown })}
        inputLabel="补充问题"
        onValueChange={onValueChange}
        placeholder="输入问题"
        value="text"
      />,
    );

    const input = screen.getByRole("textbox", { name: "补充问题" });
    expect(input).toHaveProperty("readOnly", true);
    fireEvent.change(input, { target: { value: "text!" } });
    expect(onValueChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Backspace", code: "Backspace" });
    expect(onKeyDown).toHaveBeenCalledOnce();
    const compositionStart = new CompositionEvent("compositionstart", {
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(compositionStart);
    expect(compositionStart.defaultPrevented).toBe(true);
  });

  it("projects Rime preedit inside the editor while keeping the controlled draft unchanged", async () => {
    const props = imeProps({
      state: { ...EMPTY_IME_STATE, enabled: true, composing: true, preedit: "n" },
    });
    const onKeyDown = vi.fn(() => true);
    const onTextStart = vi.fn();
    const { rerender } = render(
      <ConversationComposer
        ime={imeProps({ active: true, onKeyDown, onTextStart, compositionRange: null })}
        inputLabel="补充问题"
        placeholder="输入问题"
        value="abcd"
      />,
    );
    const input = screen.getByRole("textbox", { name: "补充问题" }) as HTMLTextAreaElement;
    input.setSelectionRange(2, 2);
    input.focus();
    fireEvent.keyDown(input, { key: "n", code: "KeyN" });

    rerender(
      <ConversationComposer
        ime={{ ...props, onKeyDown, onTextStart, compositionRange: { start: 2, end: 2 } }}
        inputLabel="补充问题"
        placeholder="输入问题"
        value="abcd"
      />,
    );
    expect(input.value).toBe("abcd");
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(2);
    expect(input).not.toHaveAttribute("data-ime-preedit-in-value");
    expect(onTextStart).toHaveBeenCalledWith({ start: 2, end: 2 });
    const preedit = await screen.findByText("n");
    expect(preedit).toHaveAttribute("data-ime-composition-preedit", "true");
    expect(preedit.closest("[data-ime-composition-projection='true']")).toBeInTheDocument();
    expect(document.activeElement).toBe(input);
  });

  it("renders composition projection without changing the business draft", async () => {
    const onValueChange = vi.fn();
    render(
      <ConversationComposer
        ime={imeProps({
          state: { ...EMPTY_IME_STATE, enabled: true, composing: true, preedit: "ni" },
          compositionRange: { start: 1, end: 3 },
        })}
        inputLabel="补充问题"
        onValueChange={onValueChange}
        placeholder="输入问题"
        value="abcd"
      />,
    );
    const input = screen.getByRole("textbox", { name: "补充问题" }) as HTMLTextAreaElement;
    expect(input.value).toBe("abcd");
    expect(await screen.findByText("ni")).toHaveAttribute("data-ime-composition-preedit", "true");
    expect(document.querySelector("[data-ime-composition-projection='true']")?.textContent).toBe(
      "anid",
    );
    expect(onValueChange).not.toHaveBeenCalled();
  });
});

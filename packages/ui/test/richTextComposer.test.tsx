import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RichTextComposer } from "../src/components/editor/RichTextComposer";
import { resolveImeTextPolicy } from "../src/ime/imeTextPolicy";

const ownedPolicy = resolveImeTextPolicy({ targetOwned: true, composing: false });
const freePolicy = resolveImeTextPolicy({ targetOwned: false, composing: false });

describe("RichTextComposer embedded IME gating", () => {
  it("derives the native-write pause from the text policy, not from aria state", () => {
    render(<RichTextComposer ariaLabel="编辑器" textPolicy={ownedPolicy} value="" />);

    const editor = screen.getByRole("textbox", { name: "编辑器" });
    expect(editor).toHaveAttribute("data-embedded-ime-target", "true");
    expect(editor).toHaveAttribute("data-ime-native-input-blocked", "true");
    expect(editor).not.toHaveAttribute("aria-readonly");
  });

  it("keeps aria-readonly for business read-only and drops the IME pause markers", () => {
    render(<RichTextComposer ariaLabel="编辑器" disabled value="只读" />);

    const editor = screen.getByRole("textbox", { name: "编辑器" });
    expect(editor).toHaveAttribute("aria-readonly", "true");
    expect(editor).not.toHaveAttribute("data-ime-native-input-blocked");
    expect(editor).not.toHaveAttribute("data-embedded-ime-target");
  });

  it("leaves a target outside the lease fully editable", () => {
    render(<RichTextComposer ariaLabel="编辑器" textPolicy={freePolicy} value="hi" />);

    const editor = screen.getByRole("textbox", { name: "编辑器" });
    expect(editor).not.toHaveAttribute("data-ime-native-input-blocked");
    expect(editor).not.toHaveAttribute("aria-readonly");
  });

  it("routes explicit text paste through ProseMirror while IME owns the editor", async () => {
    const onValueChange = vi.fn();
    const onEditorReady = vi.fn();
    render(
      <RichTextComposer
        ariaLabel="编辑器"
        onEditorReady={onEditorReady}
        onValueChange={onValueChange}
        textPolicy={ownedPolicy}
        value="abcd"
      />,
    );
    const editor = screen.getByRole("textbox", { name: "编辑器" });
    await waitFor(() => expect(onEditorReady).toHaveBeenCalled());
    const tiptap = onEditorReady.mock.calls[0]?.[0];
    if (!tiptap) throw new Error("expected TipTap editor instance");
    tiptap.commands.setTextSelection({ from: 2, to: 4 });
    onValueChange.mockClear();

    fireEvent.paste(editor, {
      clipboardData: { files: [], getData: (type: string) => (type === "text/plain" ? "XY" : "") },
    });

    await waitFor(() => expect(onValueChange).toHaveBeenCalledWith("aXYd"));
  });
});

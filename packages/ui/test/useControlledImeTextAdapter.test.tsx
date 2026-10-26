import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useControlledImeTextAdapter } from "../src/ime/adapters/useControlledImeTextAdapter";

describe("useControlledImeTextAdapter", () => {
  it("keeps the composition-start selection for commit and clears it on cancel", () => {
    const input = document.createElement("textarea");
    input.value = "abcd";
    const inputRef = { current: input };
    const onChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useControlledImeTextAdapter({ inputRef, value, onChange }),
      { initialProps: { value: "abcd" } },
    );

    input.setSelectionRange(1, 3);
    act(() => result.current.captureCompositionStart({ start: 1, end: 3 }, false));
    expect(result.current.compositionRange).toEqual({ start: 1, end: 3 });
    input.setSelectionRange(4, 4);
    act(() => result.current.captureCompositionStart({ start: 4, end: 4 }, true));
    act(() => result.current.commit("问"));

    expect(onChange).toHaveBeenLastCalledWith("a问d");
    expect(result.current.compositionRange).toBeNull();
    rerender({ value: "a问d" });
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 2]);

    act(() => result.current.captureCompositionStart({ start: 0, end: 1 }, false));
    act(() => result.current.cancelComposition());
    input.setSelectionRange(2, 2);
    act(() => result.current.commit("x"));
    expect(onChange).toHaveBeenLastCalledWith("a问xd");
  });

  it("commits into the captured selection after the textarea loses focus", () => {
    const input = document.createElement("textarea");
    input.value = "abcd";
    document.body.append(input);
    const inputRef = { current: input };
    const onChange = vi.fn();
    const { result, rerender, unmount } = renderHook(
      ({ value }: { value: string }) => useControlledImeTextAdapter({ inputRef, value, onChange }),
      { initialProps: { value: "abcd" } },
    );

    input.focus();
    input.setSelectionRange(1, 3);
    act(() => result.current.captureCompositionStart({ start: 1, end: 3 }, false));
    input.blur();
    expect(document.activeElement).not.toBe(input);

    input.setSelectionRange(4, 4);
    act(() => result.current.commit("问"));
    expect(onChange).toHaveBeenLastCalledWith("a问d");
    rerender({ value: "a问d" });
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 2]);

    unmount();
    input.remove();
  });
});

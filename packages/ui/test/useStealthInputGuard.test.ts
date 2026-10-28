import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useStealthInputGuard } from "../src/hooks/useStealthInputGuard";

describe("useStealthInputGuard", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-native-ime-isolation-failed");
  });

  it("blurs and blocks text controls while stealth is enabled", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    document.body.append(input, textarea);
    renderHook(() => useStealthInputGuard(true));

    input.focus();
    expect(document.activeElement).not.toBe(input);
    const keydown = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "a" });
    input.dispatchEvent(keydown);
    expect(keydown.defaultPrevented).toBe(true);

    textarea.focus();
    expect(document.activeElement).not.toBe(textarea);
  });

  it("keeps buttons usable but blocks native file pickers", () => {
    const button = document.createElement("button");
    const file = document.createElement("input");
    file.type = "file";
    document.body.append(button, file);
    renderHook(() => useStealthInputGuard(true));

    button.focus();
    expect(document.activeElement).toBe(button);
    const click = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    button.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);

    const fileClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    file.dispatchEvent(fileClick);
    expect(fileClick.defaultPrevented).toBe(true);
  });

  it("blocks focus on legacy embedded IME targets", () => {
    const textarea = document.createElement("textarea");
    textarea.dataset.embeddedImeTarget = "true";
    document.body.append(textarea);
    renderHook(() => useStealthInputGuard(true));

    const pointer = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    textarea.dispatchEvent(pointer);
    expect(pointer.defaultPrevented).toBe(true);

    textarea.focus();
    expect(document.activeElement).not.toBe(textarea);
  });

  it("restores text input when stealth is disabled", () => {
    const input = document.createElement("input");
    document.body.append(input);
    const { rerender } = renderHook(({ enabled }) => useStealthInputGuard(enabled), {
      initialProps: { enabled: true },
    });
    rerender({ enabled: false });

    input.focus();
    expect(document.activeElement).toBe(input);
  });

  it("stays inert while stealth is disabled", () => {
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    renderHook(() => useStealthInputGuard(false));

    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    const composition = new CompositionEvent("compositionstart", {
      bubbles: true,
      cancelable: true,
      data: "ni",
    });
    textarea.dispatchEvent(composition);
    expect(composition.defaultPrevented).toBe(false);
    expect(document.documentElement).not.toHaveAttribute("data-native-ime-isolation-failed");
    expect(document.activeElement).toBe(textarea);

    const keydown = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "a" });
    textarea.dispatchEvent(keydown);
    expect(keydown.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(textarea);
  });

  it("locks composition on legacy embedded IME targets", () => {
    const textarea = document.createElement("textarea");
    textarea.dataset.embeddedImeTarget = "true";
    document.body.append(textarea);
    renderHook(() => useStealthInputGuard(true));

    textarea.focus();
    expect(document.activeElement).not.toBe(textarea);

    const composition = new CompositionEvent("compositionstart", {
      bubbles: true,
      cancelable: true,
      data: "ni",
    });
    textarea.dispatchEvent(composition);
    expect(composition.defaultPrevented).toBe(true);
    expect(document.documentElement).toHaveAttribute("data-native-ime-isolation-failed");
    expect(document.activeElement).not.toBe(textarea);

    const keydown = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "a" });
    textarea.dispatchEvent(keydown);
    expect(keydown.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(textarea);
  });
});

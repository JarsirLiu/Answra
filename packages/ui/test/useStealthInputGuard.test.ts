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

  it("allows focus on the embedded IME target", () => {
    const textarea = document.createElement("textarea");
    textarea.dataset.embeddedImeTarget = "true";
    document.body.append(textarea);
    renderHook(() => useStealthInputGuard(true));

    const pointer = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    textarea.dispatchEvent(pointer);
    expect(pointer.defaultPrevented).toBe(false);

    textarea.focus();
    expect(document.activeElement).toBe(textarea);
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

  it("blocks system composition even when stealth is disabled", () => {
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    renderHook(() => useStealthInputGuard(false));

    const composition = new CompositionEvent("compositionstart", {
      bubbles: true,
      cancelable: true,
      data: "ni",
    });
    textarea.dispatchEvent(composition);
    const beforeInput = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertCompositionText",
      data: "你",
    });
    textarea.dispatchEvent(beforeInput);

    expect(composition.defaultPrevented).toBe(true);
    expect(beforeInput.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(textarea);

    textarea.focus();
    expect(document.activeElement).not.toBe(textarea);
  });
});

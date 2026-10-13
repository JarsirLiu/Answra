import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useStealthInputGuard } from "../src/hooks/useStealthInputGuard";

describe("useStealthInputGuard", () => {
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
});

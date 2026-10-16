import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EmbeddedImeInput } from "../src/components/controls/EmbeddedImeInput";
import { useStealthInputGuard } from "../src/hooks/useStealthInputGuard";
import { ControlledTextCompositionMirror } from "../src/ime/adapters/ControlledTextCompositionMirror";

function StealthSettingsInput() {
  useStealthInputGuard(true);
  return (
    <EmbeddedImeInput
      aria-label="模型名称"
      onValueChange={() => undefined}
      targetId="settings-model"
      value=""
    />
  );
}

describe("EmbeddedImeInput", () => {
  it("remains focusable under stealth because input is handled by the embedded IME", () => {
    render(<StealthSettingsInput />);
    const input = screen.getByRole("textbox", { name: "模型名称" });

    expect(input).toHaveAttribute("data-embedded-ime-target", "true");
    fireEvent.pointerDown(input);
    input.focus();

    expect(document.activeElement).toBe(input);
  });

  it("projects temporary composition text without changing the controlled input value", () => {
    const input = document.createElement("input");
    input.value = "abcd";
    const inputRef = { current: input };
    render(
      <ControlledTextCompositionMirror
        inputRef={inputRef}
        preedit="ni"
        range={{ start: 1, end: 3 }}
        targetId="settings-model"
        value="abcd"
      />,
    );

    expect(input.value).toBe("abcd");
    expect(document.querySelector("[data-ime-composition-projection='true']")?.textContent).toBe(
      "anid",
    );
    expect(document.querySelector("[data-ime-composition-caret='true']")).toBeInTheDocument();
  });

  it("uses the preserved composition color when the native input text is transparent", () => {
    const input = document.createElement("input");
    input.style.setProperty("--ime-composition-text-color", "rgb(25, 35, 45)");
    const getComputedStyle = vi.spyOn(window, "getComputedStyle").mockImplementation(((
      element: Element,
    ) => {
      const style = window.document.createElement("div").style;
      if (element === input) {
        style.color = "transparent";
        style.setProperty("--ime-composition-text-color", "rgb(25, 35, 45)");
      }
      return style;
    }) as typeof window.getComputedStyle);
    render(
      <ControlledTextCompositionMirror
        inputRef={{ current: input }}
        preedit="ni"
        range={{ start: 0, end: 0 }}
        targetId="settings-model"
        value=""
      />,
    );

    expect(document.querySelector(".ime-composition-mirror")?.getAttribute("style")).toContain(
      "color: rgb(25, 35, 45)",
    );
    getComputedStyle.mockRestore();
  });
});

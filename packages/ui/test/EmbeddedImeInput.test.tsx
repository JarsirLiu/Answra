import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmbeddedImeInput } from "../src/components/controls/EmbeddedImeInput";
import { useStealthInputGuard } from "../src/hooks/useStealthInputGuard";

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
});

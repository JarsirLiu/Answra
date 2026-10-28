import type {
  DesktopBridge,
  ImeSessionCommand,
  ImeSessionSnapshot,
  ImeState,
} from "@answra/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EmbeddedImeInput } from "../src/components/controls/EmbeddedImeInput";
import { useStealthInputGuard } from "../src/hooks/useStealthInputGuard";
import { ControlledTextCompositionMirror } from "../src/ime/adapters/ControlledTextCompositionMirror";
import { resetImeInputTargetCoordinatorForTests } from "../src/ime/imeInputTargetCoordinator";

function createImeBridge(): DesktopBridge {
  let snapshot: ImeSessionSnapshot = {
    phase: "idle",
    engine: {
      enabled: false,
      inputMode: "chinese",
      composing: false,
      preedit: "",
      candidates: [],
      selectedIndex: 0,
      page: 0,
      hasNextPage: false,
    },
    revision: 0,
  };
  const listeners = new Set<(next: ImeSessionSnapshot) => void>();
  return {
    fitContent: vi.fn(),
    close: vi.fn(),
    imeAvailable: true,
    imeSessionCommand: async (command: ImeSessionCommand) => {
      if (command.type === "acquireTarget") {
        const engine: ImeState = { ...snapshot.engine, enabled: true };
        snapshot = {
          phase: "owned",
          owner: { windowId: 1, webContentsId: 1, targetId: command.targetId, generation: 1 },
          engine,
          revision: snapshot.revision + 1,
        };
      }
      for (const listener of listeners) listener(snapshot);
      return { commandId: command.commandId, accepted: true, snapshot };
    },
    getImeSessionSnapshot: async () => snapshot,
    onImeSessionSnapshot: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as DesktopBridge;
}

function StealthSettingsInput() {
  useStealthInputGuard(true);
  return (
    <EmbeddedImeInput
      aria-label="模型名称"
      enabled
      onValueChange={() => undefined}
      targetId="settings-model"
      value=""
    />
  );
}

describe("EmbeddedImeInput", () => {
  beforeEach(() => resetImeInputTargetCoordinatorForTests());
  it("keeps the stealth input unfocused while a pointer establishes the logical target", async () => {
    render(<StealthSettingsInput />);
    await act(async () => {});
    const input = screen.getByRole("textbox", { name: "模型名称" });
    const focus = vi.fn();
    const blur = vi.fn();
    input.addEventListener("focus", focus);
    input.addEventListener("blur", blur);

    expect(input).toHaveAttribute("data-embedded-ime-target", "true");
    await act(async () => {
      fireEvent.pointerDown(input);
    });

    expect(document.activeElement).not.toBe(input);
    expect(focus).not.toHaveBeenCalled();
    expect(blur).not.toHaveBeenCalled();
  });

  it("inserts pasted text at the selected range while keeping the input read-only", async () => {
    const onValueChange = vi.fn();
    const bridge = createImeBridge();
    render(
      <EmbeddedImeInput
        aria-label="模型名称"
        bridge={bridge}
        enabled
        onValueChange={onValueChange}
        targetId="settings-model"
        value="abcd"
      />,
    );
    const input = screen.getByRole("textbox", { name: "模型名称" }) as HTMLInputElement;
    await act(async () => fireEvent.pointerDown(input));
    await waitFor(() => expect(input).toHaveProperty("readOnly", true));
    input.setSelectionRange(1, 3);
    fireEvent.select(input);

    fireEvent.paste(input, {
      clipboardData: { getData: (type: string) => (type === "text/plain" ? "XY" : "") },
    });

    expect(input).toHaveProperty("readOnly", true);
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("aXYd");
  });

  it("leaves the native input path open when the embedded IME is disabled", async () => {
    const onValueChange = vi.fn();
    render(
      <EmbeddedImeInput
        aria-label="模型名称"
        bridge={createImeBridge()}
        enabled={false}
        onValueChange={onValueChange}
        targetId="settings-model"
        value=""
      />,
    );
    await act(async () => {});
    const input = screen.getByRole("textbox", { name: "模型名称" }) as HTMLInputElement;

    expect(input).toHaveProperty("readOnly", false);
    fireEvent.change(input, { target: { value: "abc" } });
    expect(onValueChange).toHaveBeenCalledWith("abc");
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

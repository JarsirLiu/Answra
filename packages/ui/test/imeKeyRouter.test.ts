import { describe, expect, it } from "vitest";
import { resolveImeKeyRoute } from "../src/ime/imeKeyRouter";

function key(key: string, overrides: Partial<Parameters<typeof resolveImeKeyRoute>[0]> = {}) {
  return {
    key,
    code: key === "Shift" ? "ShiftLeft" : key.length === 1 ? `Key${key.toUpperCase()}` : key,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    ...overrides,
  };
}

describe("resolveImeKeyRoute", () => {
  it("routes Shift keydown to mode only, and consumes no engine keyup", () => {
    expect(resolveImeKeyRoute(key("Shift"), { inputMode: "chinese", composing: true })).toEqual({
      type: "toggle-mode",
    });
    expect(
      resolveImeKeyRoute(key("Shift"), { inputMode: "chinese", composing: true }, true),
    ).toEqual({ type: "consumed" });
  });

  it("sends composing digits to the engine and idle digits to the editor once", () => {
    expect(resolveImeKeyRoute(key("5"), { inputMode: "chinese", composing: true })).toEqual({
      type: "engine",
      key: "5",
      release: false,
    });
    expect(resolveImeKeyRoute(key("5"), { inputMode: "chinese", composing: false })).toEqual({
      type: "editor",
      text: "5",
    });
  });

  it("leaves ASCII text and browser shortcuts to the editor/browser", () => {
    expect(resolveImeKeyRoute(key("a"), { inputMode: "ascii", composing: false })).toEqual({
      type: "browser",
    });
    expect(
      resolveImeKeyRoute(key("a", { ctrlKey: true }), {
        inputMode: "chinese",
        composing: false,
      }),
    ).toEqual({ type: "browser" });
  });

  it("normalizes Windows Process key codes for engine routing", () => {
    expect(
      resolveImeKeyRoute(key("Process", { code: "KeyA" }), {
        inputMode: "chinese",
        composing: false,
      }),
    ).toEqual({ type: "engine", key: "a", release: false });
  });
});

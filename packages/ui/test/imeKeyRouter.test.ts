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
  it("routes both Shift edges to Rime with the physical key identity", () => {
    expect(resolveImeKeyRoute(key("Shift"), { inputMode: "chinese", composing: true })).toEqual({
      type: "engine",
      key: "Shift",
      release: false,
    });
    expect(
      resolveImeKeyRoute(key("Shift"), { inputMode: "chinese", composing: true }, true),
    ).toEqual({ type: "engine", key: "Shift", release: true });
  });

  it("routes printable keys through Rime regardless of the cached mode", () => {
    expect(resolveImeKeyRoute(key("5"), { inputMode: "chinese", composing: true })).toEqual({
      type: "engine",
      key: "5",
      release: false,
    });
    expect(resolveImeKeyRoute(key("5"), { inputMode: "chinese", composing: false })).toEqual({
      type: "engine",
      key: "5",
      release: false,
    });
  });

  it("routes ASCII text through the engine and leaves browser shortcuts alone", () => {
    expect(resolveImeKeyRoute(key("a"), { inputMode: "ascii", composing: false })).toEqual({
      type: "engine",
      key: "a",
      release: false,
    });
    expect(
      resolveImeKeyRoute(key("a", { ctrlKey: true }), {
        inputMode: "chinese",
        composing: false,
      }),
    ).toEqual({ type: "browser" });
  });

  it("returns typed editor commands for deletion and navigation outside composition", () => {
    expect(
      resolveImeKeyRoute(key("Backspace"), { inputMode: "chinese", composing: false }),
    ).toEqual({
      type: "editor",
      command: { type: "deleteBackward" },
    });
    expect(resolveImeKeyRoute(key("Delete"), { inputMode: "ascii", composing: false })).toEqual({
      type: "editor",
      command: { type: "deleteForward" },
    });
    expect(
      resolveImeKeyRoute(key("ArrowLeft", { shiftKey: true }), {
        inputMode: "chinese",
        composing: false,
      }),
    ).toEqual({ type: "editor", command: { type: "moveCaret", direction: "left", extend: true } });
    expect(resolveImeKeyRoute(key("Backspace"), { inputMode: "chinese", composing: true })).toEqual(
      { type: "engine", key: "Backspace", release: false },
    );
  });

  it("hands vertical navigation back to the browser outside composition", () => {
    // 纵向移动依赖折行渲染，受控编辑器只算字符串偏移，必须交还原生。
    for (const vertical of ["ArrowUp", "ArrowDown", "PageUp", "PageDown"]) {
      expect(resolveImeKeyRoute(key(vertical), { inputMode: "chinese", composing: false })).toEqual(
        { type: "browser" },
      );
    }
    expect(resolveImeKeyRoute(key("ArrowDown"), { inputMode: "chinese", composing: true })).toEqual(
      { type: "engine", key: "ArrowDown", release: false },
    );
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

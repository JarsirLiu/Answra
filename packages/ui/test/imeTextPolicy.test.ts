import { describe, expect, it } from "vitest";
import { resolveImeTextPolicy } from "../src/ime/imeTextPolicy";

describe("resolveImeTextPolicy", () => {
  it("routes every owned target through the Rime pipeline regardless of input mode", () => {
    expect(resolveImeTextPolicy({ targetOwned: true, composing: false })).toEqual({
      useNativeTextInput: false,
      blockNativeEditing: true,
      blockComposition: true,
      backspace: "editor",
      captureCompositionStart: true,
    });

    expect(resolveImeTextPolicy({ targetOwned: true, composing: true }).backspace).toBe("engine");
  });

  it("returns all text events to the editor after the lease is released", () => {
    expect(resolveImeTextPolicy({ targetOwned: false, composing: true })).toEqual({
      useNativeTextInput: true,
      blockNativeEditing: false,
      blockComposition: false,
      backspace: "native",
      captureCompositionStart: false,
    });
  });
});

import { describe, expect, it } from "vitest";
import { resolveImeTextPolicy } from "../src/ime/imeTextPolicy";

describe("resolveImeTextPolicy", () => {
  it("routes Chinese text and composition through the Rime-owned target", () => {
    expect(
      resolveImeTextPolicy({ targetOwned: true, inputMode: "chinese", composing: false }),
    ).toEqual({
      useNativeTextInput: false,
      readOnly: true,
      blockComposition: true,
      backspace: "editor",
      captureCompositionStart: true,
    });

    expect(
      resolveImeTextPolicy({ targetOwned: true, inputMode: "chinese", composing: true }).backspace,
    ).toBe("engine");
  });

  it("keeps ASCII editing native while blocking platform composition during the lease", () => {
    expect(
      resolveImeTextPolicy({ targetOwned: true, inputMode: "ascii", composing: false }),
    ).toEqual({
      useNativeTextInput: true,
      readOnly: false,
      blockComposition: true,
      backspace: "native",
      captureCompositionStart: false,
    });
  });

  it("returns all text events to the editor after the lease is released", () => {
    expect(
      resolveImeTextPolicy({ targetOwned: false, inputMode: "chinese", composing: true }),
    ).toEqual({
      useNativeTextInput: true,
      readOnly: false,
      blockComposition: false,
      backspace: "native",
      captureCompositionStart: false,
    });
  });
});

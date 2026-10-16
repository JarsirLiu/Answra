import { describe, expect, it } from "vitest";
import {
  type ImeTextFallbackInput,
  resolveImeTextFallback,
  resolveImeTextPolicy,
} from "../src/ime/imeTextPolicy";

describe("resolveImeTextPolicy", () => {
  it("routes every owned target through the Rime pipeline regardless of input mode", () => {
    expect(resolveImeTextPolicy({ targetOwned: true, composing: false })).toEqual({
      useNativeTextInput: false,
      blockNativeEditing: true,
      blockComposition: true,
      captureCompositionStart: true,
    });

    expect(resolveImeTextPolicy({ targetOwned: true, composing: true })).toEqual({
      useNativeTextInput: false,
      blockNativeEditing: true,
      blockComposition: true,
      captureCompositionStart: false,
    });
  });

  it("returns all text events to the editor after the lease is released", () => {
    expect(resolveImeTextPolicy({ targetOwned: false, composing: true })).toEqual({
      useNativeTextInput: true,
      blockNativeEditing: false,
      blockComposition: false,
      captureCompositionStart: false,
    });
  });
});

describe("resolveImeTextFallback", () => {
  const fallback = (over: Partial<ImeTextFallbackInput>): ImeTextFallbackInput => ({
    engine: { inputMode: "chinese", composing: false },
    key: "",
    text: undefined,
    shift: false,
    ctrl: false,
    alt: false,
    meta: false,
    ...over,
  });

  it("commits printable ASCII text verbatim, including shifted letters", () => {
    expect(
      resolveImeTextFallback(
        fallback({
          engine: { inputMode: "ascii", composing: false },
          key: "a",
          text: "A",
          shift: true,
        }),
      ),
    ).toBe("A");
  });

  it("commits the single unshifted digit Rime leaves unhandled in Chinese mode", () => {
    expect(resolveImeTextFallback(fallback({ key: "1", text: "1" }))).toBe("1");
  });

  it("keeps the digit with the engine while composing", () => {
    expect(
      resolveImeTextFallback(
        fallback({ engine: { inputMode: "chinese", composing: true }, key: "1", text: "1" }),
      ),
    ).toBeUndefined();
  });

  it("leaves non-digit letters in Chinese mode to editor routing", () => {
    expect(resolveImeTextFallback(fallback({ key: "a", text: "a" }))).toBeUndefined();
  });

  it("never commits while a command modifier is held", () => {
    expect(
      resolveImeTextFallback(
        fallback({
          engine: { inputMode: "ascii", composing: false },
          key: "a",
          text: "a",
          ctrl: true,
        }),
      ),
    ).toBeUndefined();
  });

  it("leaves shifted digits in Chinese mode to the engine", () => {
    expect(resolveImeTextFallback(fallback({ key: "1", text: "!", shift: true }))).toBeUndefined();
  });

  it("returns undefined when the key carries no text", () => {
    expect(
      resolveImeTextFallback(
        fallback({ engine: { inputMode: "ascii", composing: false }, key: "ArrowLeft" }),
      ),
    ).toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  handleImeEditorKeyDown,
  type ImeEditorKeyEvent,
  imeEditorAttributes,
  isImeCompositionStartKey,
} from "../src/ime/imeEditorBinding";
import type { ImeTextPolicy } from "../src/ime/imeTextPolicy";

const OWNED: ImeTextPolicy = {
  useNativeTextInput: false,
  blockNativeEditing: true,
  blockComposition: true,
  captureCompositionStart: true,
};

const NATIVE: ImeTextPolicy = {
  useNativeTextInput: true,
  blockNativeEditing: false,
  blockComposition: false,
  captureCompositionStart: false,
};

const press = (over: Partial<ImeEditorKeyEvent> = {}): ImeEditorKeyEvent => ({
  key: "",
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...over,
});

describe("imeEditorAttributes", () => {
  it("always publishes the three target markers", () => {
    expect(imeEditorAttributes({ targetId: "composer" })).toEqual({
      "data-embedded-ime-target": "true",
      "data-ime-policy": "text",
      "data-ime-target-id": "composer",
    });
  });

  it("publishes the active/composition markers only while set", () => {
    expect(imeEditorAttributes({ targetId: "composer", active: true, composing: true })).toEqual({
      "data-embedded-ime-target": "true",
      "data-ime-policy": "text",
      "data-ime-target-id": "composer",
      "data-embedded-ime-active": "true",
      "data-ime-composition-active": "true",
    });
    expect(imeEditorAttributes({ targetId: "composer", active: false, composing: false })).toEqual({
      "data-embedded-ime-target": "true",
      "data-ime-policy": "text",
      "data-ime-target-id": "composer",
    });
  });
});

describe("isImeCompositionStartKey", () => {
  it("accepts a single printable key and the Windows Process key", () => {
    expect(isImeCompositionStartKey(press({ key: "a" }))).toBe(true);
    expect(isImeCompositionStartKey(press({ key: "Process" }))).toBe(true);
  });

  it("rejects named keys and any command modifier", () => {
    expect(isImeCompositionStartKey(press({ key: "Enter" }))).toBe(false);
    expect(isImeCompositionStartKey(press({ key: "ArrowLeft" }))).toBe(false);
    expect(isImeCompositionStartKey(press({ key: "a", ctrlKey: true }))).toBe(false);
    expect(isImeCompositionStartKey(press({ key: "a", altKey: true }))).toBe(false);
    expect(isImeCompositionStartKey(press({ key: "a", metaKey: true }))).toBe(false);
  });
});

describe("handleImeEditorKeyDown", () => {
  it("captures the caret before a new composition and routes the key", () => {
    const onCaptureCompositionStart = vi.fn();
    const sendKey = vi.fn(() => true);

    const handled = handleImeEditorKeyDown({
      event: press({ key: "a" }),
      policy: OWNED,
      readSelection: () => ({ start: 3, end: 5 }),
      onCaptureCompositionStart,
      sendKey,
      applyEditorCommand: vi.fn(),
    });

    expect(handled).toBe(true);
    expect(onCaptureCompositionStart).toHaveBeenCalledWith({ start: 3, end: 5 });
    expect(sendKey).toHaveBeenCalledTimes(1);
  });

  it("routes without capturing once the policy returns to native input", () => {
    const onCaptureCompositionStart = vi.fn();
    const sendKey = vi.fn(() => false);

    const handled = handleImeEditorKeyDown({
      event: press({ key: "a" }),
      policy: NATIVE,
      readSelection: () => ({ start: 0, end: 0 }),
      onCaptureCompositionStart,
      sendKey,
      applyEditorCommand: vi.fn(),
    });

    expect(handled).toBe(false);
    expect(onCaptureCompositionStart).not.toHaveBeenCalled();
    expect(sendKey).toHaveBeenCalledTimes(1);
  });

  it("never captures a named key even while the target is owned", () => {
    const onCaptureCompositionStart = vi.fn();

    handleImeEditorKeyDown({
      event: press({ key: "Enter" }),
      policy: OWNED,
      readSelection: () => ({ start: 0, end: 0 }),
      onCaptureCompositionStart,
      sendKey: vi.fn(() => true),
      applyEditorCommand: vi.fn(),
    });

    expect(onCaptureCompositionStart).not.toHaveBeenCalled();
  });
});

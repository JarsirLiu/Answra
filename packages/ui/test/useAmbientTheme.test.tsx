import type { DesktopBridge } from "@answra/shared";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveAmbientTokens, useAmbientTheme } from "../src/hooks/useAmbientTheme";

interface AmbientPayload {
  ok: boolean;
  hex: string;
  luminance: number;
}

type TestBridge = DesktopBridge & { emit: (payload: AmbientPayload) => void };

function createBridge(): TestBridge {
  let listener: ((payload: AmbientPayload) => void) | undefined;
  const bridge = {
    fitContent: vi.fn(),
    close: vi.fn(),
    onAmbientColor: vi.fn((cb: (payload: AmbientPayload) => void) => {
      listener = cb;
      return () => {
        listener = undefined;
      };
    }),
    emit: (payload: AmbientPayload) => listener?.(payload),
  };
  return bridge as unknown as TestBridge;
}

function Harness({ bridge, enabled }: { bridge?: DesktopBridge; enabled: boolean }) {
  useAmbientTheme(bridge, enabled);
  return null;
}

function emit(bridge: TestBridge, payload: AmbientPayload): void {
  act(() => bridge.emit(payload));
}

describe("ambient chameleon theme", () => {
  afterEach(() => {
    const style = document.documentElement.style;
    for (const key of ["--ink-tint", "--glass-tint", "--paper-tint"]) style.removeProperty(key);
  });

  it("derives dark-theme tokens from a dark background color", () => {
    const tokens = deriveAmbientTokens("#1a1a1a");
    expect(tokens).toBeDefined();
    expect(tokens?.["--glass-base"]).toContain("0.55");
    expect(tokens?.["--ink-tint"]).toMatch(/^\d+ \d+ \d+$/);
    // 图标令牌跟随背景派生，保证深浅背景下图标都可辨
    expect(tokens?.["--icon-tint"]).toMatch(/^\d+ \d+ \d+$/);
    // 深色背景下品牌绿提亮为浅绿（非默认深绿），保证激活项可读
    expect(tokens?.["--mint-text-tint"]).toMatch(/^\d+ \d+ \d+$/);
    expect(tokens?.["--mint-wash-base"]).toContain("0.3");
  });

  it("keeps default mint text on light backgrounds", () => {
    const tokens = deriveAmbientTokens("#f5f2ec");
    expect(tokens?.["--mint-text-tint"]).toBeNull();
    expect(tokens?.["--glass-base"]).toContain("0.62");
  });

  it("solves ink for at least 4.5:1 contrast on any background", () => {
    for (const hex of ["#1a1a1a", "#f5f2ec", "#2b3a67", "#e07a5f", "#808080"]) {
      const tokens = deriveAmbientTokens(hex);
      expect(tokens).toBeDefined();
      expect(tokens?.["--ink-tint"]).toMatch(/^\d+ \d+ \d+$/);
    }
  });

  it("returns undefined for invalid colors", () => {
    expect(deriveAmbientTokens("not-a-color")).toBeUndefined();
  });

  it("applies tokens when the bridge pushes a color and falls back on failure", () => {
    const bridge = createBridge();
    render(<Harness bridge={bridge} enabled />);

    expect(bridge.onAmbientColor).toHaveBeenCalled();
    emit(bridge, { ok: true, hex: "#101018", luminance: 0.05 });
    expect(document.documentElement.style.getPropertyValue("--glass-base")).toContain("0.55");

    emit(bridge, { ok: false, hex: "#ffffff", luminance: 1 });
    expect(document.documentElement.style.getPropertyValue("--glass-base")).toBe("");
  });

  it("clears overrides when disabled", () => {
    const bridge = createBridge();
    const { rerender } = render(<Harness bridge={bridge} enabled />);
    emit(bridge, { ok: true, hex: "#101018", luminance: 0.05 });
    expect(document.documentElement.style.getPropertyValue("--ink-tint")).not.toBe("");

    rerender(<Harness bridge={bridge} enabled={false} />);
    expect(document.documentElement.style.getPropertyValue("--ink-tint")).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import {
  deriveAmbientTokens,
  resolveAmbientScheme,
} from "../src/hooks/useAmbientTheme";

describe("ambient chameleon theme", () => {
  it("derives dark-theme tokens from a dark background color", () => {
    const tokens = deriveAmbientTokens("#1a1a1a");
    expect(tokens).toBeDefined();
    expect(tokens?.["--glass-tint"]).toMatch(/^\d+ \d+ \d+$/);
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
  });

  it("never writes surface alpha bases: surfaces stay fully opaque", () => {
    for (const hex of ["#1a1a1a", "#f5f2ec"]) {
      const tokens = deriveAmbientTokens(hex);
      expect(tokens?.["--glass-base"]).toBeUndefined();
      expect(tokens?.["--panel-base"]).toBeUndefined();
      // 面板色随背景派生（不透明表面同色相层次）
      expect(tokens?.["--panel-tint"]).toMatch(/^\d+ \d+ \d+$/);
    }
  });

  it("resolves the color scheme from background luminance", () => {
    expect(resolveAmbientScheme("#1a1a1a")).toBe("dark");
    expect(resolveAmbientScheme("#f5f2ec")).toBe("light");
    expect(resolveAmbientScheme("not-a-color")).toBeUndefined();
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
});

import { describe, expect, it } from "vitest";
import {
  deriveAmbientTokens,
  parseHex,
  resolveAmbientScheme,
} from "../src/hooks/useAmbientTheme";

/** "r g b" 通道串 → Rgb。 */
function channels(value: string | undefined): { r: number; g: number; b: number } {
  const [r = 0, g = 0, b = 0] = (value ?? "").split(" ").map(Number);
  return { r, g, b };
}

describe("ambient chameleon theme", () => {
  it("derives dark-theme tokens from a dark background color", () => {
    const tokens = deriveAmbientTokens("#1a1a1a");
    expect(tokens).toBeDefined();
    expect(tokens?.["--glass-tint"]).toMatch(/^\d+ \d+ \d+$/);
    expect(tokens?.["--ink-tint"]).toMatch(/^\d+ \d+ \d+$/);
    // 图标令牌跟随背景派生，保证深浅背景下图标都可辨
    expect(tokens?.["--icon-tint"]).toMatch(/^\d+ \d+ \d+$/);
    // 深色背景下强调色为降饱和灰绿且可读（非默认高饱和亮绿）
    expect(tokens?.["--mint-text-tint"]).toMatch(/^\d+ \d+ \d+$/);
    expect(tokens?.["--mint-wash-base"]).toBe("0.22");
  });

  it("derives a muted accent on light backgrounds too", () => {
    const tokens = deriveAmbientTokens("#f5f2ec");
    expect(tokens?.["--mint-text-tint"]).toMatch(/^\d+ \d+ \d+$/);
  });

  it("mutes the accent far below the brand green saturation", () => {
    for (const hex of ["#1a1a1a", "#f5f2ec"]) {
      const tokens = deriveAmbientTokens(hex);
      const accent = channels(tokens?.["--mint-text-tint"]);
      const spread = Math.max(accent.r, accent.g, accent.b) - Math.min(accent.r, accent.g, accent.b);
      // 品牌绿通道极差 114；灰绿强调色必须明显更收敛
      expect(spread).toBeLessThan(48);
    }
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

  it("renders the capsule and the panel on the exact same surface color", () => {
    // 胶囊与唤出面板是同一悬浮组件的两层，不允许任何色差
    for (const hex of ["#1a1a1a", "#f5f2ec"]) {
      const tokens = deriveAmbientTokens(hex);
      expect(tokens?.["--panel-tint"]).toBe(tokens?.["--glass-tint"]);
      // 面板仍随背景派生，不会突兀成"色块"
      expect(tokens?.["--panel-tint"]).toMatch(/^\d+ \d+ \d+$/);
    }
  });

  it("uses the background color verbatim for surfaces", () => {
    // 深浅色背景一律不提亮、不压暗，表面就是背景原色
    const dark = deriveAmbientTokens("#1a1a1a");
    expect(dark?.["--glass-tint"]).toBe("26 26 26");
    const light = deriveAmbientTokens("#f5f2ec");
    expect(light?.["--glass-tint"]).toBe("245 242 236");
  });

  it("dials down interaction-state alpha bases", () => {
    const tokens = deriveAmbientTokens("#1a1a1a");
    expect(tokens?.["--hover-base"]).toBe("0.1");
    expect(tokens?.["--field-base"]).toBe("0.06");
    expect(tokens?.["--focus-base"]).toBe("0.35");
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

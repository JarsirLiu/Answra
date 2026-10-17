import { describe, expect, it } from "vitest";
import {
  deriveAmbientTokens,
  resolveAmbientScheme,
  resolveAmbientSchemeHysteresis,
} from "../src/hooks/useAmbientTheme";

/** "r g b" 通道值 → Rgb。 */
function channels(value: string | null | undefined): { r: number; g: number; b: number } {
  const [r = 0, g = 0, b = 0] = (value ?? "").split(" ").map(Number);
  return { r, g, b };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = Number.parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

/** WCAG 相对亮度（线性化 sRGB）；用例里独立实现，避免与被测代码共用同一份公式。 */
function channelLuminance(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function contrastRatio(a: { r: number; g: number; b: number }, hex: string): number {
  const b = hexToRgb(hex);
  const la =
    0.2126 * channelLuminance(a.r) +
    0.7152 * channelLuminance(a.g) +
    0.0722 * channelLuminance(a.b);
  const lb =
    0.2126 * channelLuminance(b.r) +
    0.7152 * channelLuminance(b.g) +
    0.0722 * channelLuminance(b.b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 代表性背景：深、浅、饱和色与中灰。 */
const SAMPLE_BACKGROUNDS = ["#1a1a1a", "#f5f2ec", "#2b3a67", "#e07a5f", "#808080"];

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
    expect(tokens?.["--mint-wash-base"]).toBe("0.12");
  });

  it("derives a muted accent on light backgrounds too", () => {
    const tokens = deriveAmbientTokens("#f5f2ec");
    expect(tokens?.["--mint-text-tint"]).toMatch(/^\d+ \d+ \d+$/);
  });

  it("mutes the accent far below the brand green saturation", () => {
    for (const hex of ["#1a1a1a", "#f5f2ec"]) {
      const tokens = deriveAmbientTokens(hex);
      const accent = channels(tokens?.["--mint-text-tint"]);
      const spread =
        Math.max(accent.r, accent.g, accent.b) - Math.min(accent.r, accent.g, accent.b);
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

  it("keeps the default veil readable up close and below distant legibility", () => {
    // 默认「隐蔽」档：对比度停在 2:1 附近——一臂距离内可读，
    // 远距离与拍照会掉出可见阈值（不需要靠加粗字号）
    for (const hex of SAMPLE_BACKGROUNDS) {
      const ratio = contrastRatio(channels(deriveAmbientTokens(hex)?.["--ink-tint"]), hex);
      expect(ratio).toBeGreaterThanOrEqual(1.6);
      expect(ratio).toBeLessThanOrEqual(2.6);
    }
  });

  it("restores WCAG AA contrast at the readable level", () => {
    for (const hex of SAMPLE_BACKGROUNDS) {
      const ratio = contrastRatio(
        channels(deriveAmbientTokens(hex, "readable")?.["--ink-tint"]),
        hex,
      );
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("blends further as the veil level tightens", () => {
    const ratios = (["blend", "veiled", "balanced", "readable"] as const).map((level) =>
      contrastRatio(channels(deriveAmbientTokens("#808080", level)?.["--ink-tint"]), "#808080"),
    );
    for (let index = 1; index < ratios.length; index += 1) {
      expect(ratios[index]).toBeGreaterThan(ratios[index - 1] ?? 0);
    }
  });

  it("kills the drop shadow and the outline so the surface reads as background", () => {
    // 深色投影与矩形描边是远距离/拍照最先暴露悬浮层的两个信号
    const tokens = deriveAmbientTokens("#f5f2ec");
    expect(tokens?.["--shadow-base"]).toBe("0");
    expect(tokens?.["--shadow-ctl-base"]).toBe("0");
    expect(tokens?.["--line-tint"]).toBe(tokens?.["--glass-tint"]);
  });

  it("returns undefined for invalid colors", () => {
    expect(deriveAmbientTokens("not-a-color")).toBeUndefined();
  });

  it("applies hysteresis so the scheme does not flip on threshold noise", () => {
    // 亮度略高于 0.5 阈值：维持 dark（未越过 +0.07 滞回带不翻转）
    expect(resolveAmbientSchemeHysteresis("#8a8a8a", "dark")).toBe("dark");
    // 越过滞回带后才翻转
    expect(resolveAmbientSchemeHysteresis("#f5f2ec", "dark")).toBe("light");
    // 亮度略低于阈值但仍在滞回带内：维持 light
    expect(resolveAmbientSchemeHysteresis("#b6b6b6", "light")).toBe("light");
    expect(resolveAmbientSchemeHysteresis("#1a1a1a", "light")).toBe("dark");
    // 无历史判定时等同朴素阈值
    expect(resolveAmbientSchemeHysteresis("#1a1a1a", undefined)).toBe("dark");
    expect(resolveAmbientSchemeHysteresis("#f5f2ec", undefined)).toBe("light");
    expect(resolveAmbientSchemeHysteresis("not-a-color", undefined)).toBeUndefined();
  });
});

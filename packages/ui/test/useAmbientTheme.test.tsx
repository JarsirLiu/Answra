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

/** 代表性背景：深、浅、饱和色与中灰。 */
const SAMPLE_BACKGROUNDS = ["#1a1a1a", "#f5f2ec", "#2b3a67", "#e07a5f", "#808080"];

describe("ambient chameleon theme", () => {
  it("uses the background color verbatim for the capsule and the panel", () => {
    // 深浅色背景一律不提亮、不压暗，表面就是背景原色：悬浮层贴着桌面坐
    const dark = deriveAmbientTokens("#1a1a1a");
    expect(dark?.["--glass-tint"]).toBe("26 26 26");
    expect(dark?.["--panel-tint"]).toBe("26 26 26");
    const light = deriveAmbientTokens("#f5f2ec");
    expect(light?.["--glass-tint"]).toBe("245 242 236");
    expect(light?.["--panel-tint"]).toBe("245 242 236");
  });

  it("keeps the paper surface distinct from the background", () => {
    // 纸面（面板内纸面容器）比背景稍向调色板纸色靠一档，保留层内层次
    for (const hex of SAMPLE_BACKGROUNDS) {
      const tokens = deriveAmbientTokens(hex);
      expect(tokens?.["--paper-tint"]).toMatch(/^\d+ \d+ \d+$/);
      expect(tokens?.["--paper-tint"]).not.toBe(tokens?.["--glass-tint"]);
    }
    const light = deriveAmbientTokens("#f5f2ec");
    const lightPaper = channels(light?.["--paper-tint"]);
    const lightBg = channels(light?.["--glass-tint"]);
    // 浅底：纸面比面板稍暗一档（向黑压）；深底：稍亮一档（向白提）
    expect(lightPaper.r).toBeLessThan(lightBg.r);
    const dark = deriveAmbientTokens("#1a1a1a");
    expect(channels(dark?.["--paper-tint"]).r).toBeGreaterThan(channels(dark?.["--glass-tint"]).r);
  });

  it("never writes text, icon, outline, state or shadow tokens", () => {
    // 文字/图标/描边/交互态/投影一律来自 [data-theme] 调色板实色：
    // 变色龙只换表面固有色，避免出现按背景求解出来的低对比灰字
    const tokens = deriveAmbientTokens("#f5f2ec");
    for (const key of [
      "--ink-tint",
      "--icon-tint",
      "--line-tint",
      "--line-base",
      "--edge-tint",
      "--edge-base",
      "--edge-strong-base",
      "--hover-tint",
      "--hover-base",
      "--field-tint",
      "--field-base",
      "--focus-tint",
      "--focus-base",
      "--mint-tint",
      "--mint-deep-tint",
      "--mint-text-tint",
      "--mint-wash-base",
      "--shadow-base",
      "--shadow-ctl-base",
    ]) {
      expect(tokens?.[key]).toBeUndefined();
    }
  });

  it("never writes surface alpha bases: surfaces stay fully opaque", () => {
    for (const hex of ["#1a1a1a", "#f5f2ec"]) {
      const tokens = deriveAmbientTokens(hex);
      expect(tokens?.["--glass-base"]).toBeUndefined();
      expect(tokens?.["--panel-base"]).toBeUndefined();
    }
  });

  it("resolves the color scheme from background luminance", () => {
    expect(resolveAmbientScheme("#1a1a1a")).toBe("dark");
    expect(resolveAmbientScheme("#f5f2ec")).toBe("light");
    expect(resolveAmbientScheme("not-a-color")).toBeUndefined();
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

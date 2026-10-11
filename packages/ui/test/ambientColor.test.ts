import { describe, expect, it } from "vitest";

/**
 * ambient/color.ts 纯函数单测：主色统计、RGBA 位图解析、黑帧判定。
 * 与主进程 v1（apps/desktop/test/ambient.test.ts）同构，唯一差异是
 * 数据源为 canvas ImageData 的 RGBA 字节序。
 */

import { expandInner, luminanceOf, ringDominantColor, toHex } from "../src/ambient/color";

/** 构造 RGBA 位图；采样步长为 4，尺寸取 4 的倍数。 */
function fakeImageData(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const [r, g, b] = pixel(x, y);
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255; // alpha
    }
  }
  return data;
}

describe("luminanceOf / toHex", () => {
  it("computes sRGB weighted luminance", () => {
    expect(luminanceOf({ r: 255, g: 255, b: 255 })).toBeCloseTo(1);
    expect(luminanceOf({ r: 0, g: 0, b: 0 })).toBe(0);
  });

  it("formats zero-padded hex", () => {
    expect(toHex({ r: 255, g: 0, b: 16 })).toBe("#ff0010");
  });
});

describe("ringDominantColor", () => {
  it("returns the uniform background color", () => {
    const data = fakeImageData(32, 32, () => [200, 40, 40]);
    expect(ringDominantColor(data, 32, 32, { x: 8, y: 8, width: 16, height: 16 })).toEqual({
      r: 200,
      g: 40,
      b: 40,
    });
  });

  it("reads channels in RGBA order (not BGRA)", () => {
    const data = fakeImageData(32, 32, () => [30, 20, 10]);
    expect(ringDominantColor(data, 32, 32, { x: 0, y: 0, width: 0, height: 0 })).toEqual({
      r: 30,
      g: 20,
      b: 10,
    });
  });

  it("excludes the window rectangle and picks the ring color behind it", () => {
    // 环形边缘带为红色，窗口自身矩形为蓝色：结果必须是红色
    const data = fakeImageData(32, 32, (x, y) => {
      const inWindow = x >= 8 && x < 24 && y >= 8 && y < 24;
      return inWindow ? [0, 0, 255] : [255, 0, 0];
    });
    expect(ringDominantColor(data, 32, 32, { x: 8, y: 8, width: 16, height: 16 })).toEqual({
      r: 255,
      g: 0,
      b: 0,
    });
  });

  it("rejects near-black screen captures (DRM black frame)", () => {
    const data = fakeImageData(32, 32, () => [0, 0, 0]);
    expect(ringDominantColor(data, 32, 32, { x: 0, y: 0, width: 0, height: 0 })).toBeUndefined();
  });

  it("keeps dark backgrounds that are above the black-frame luminance floor", () => {
    const data = fakeImageData(32, 32, () => [10, 10, 10]);
    expect(ringDominantColor(data, 32, 32, { x: 0, y: 0, width: 0, height: 0 })).toEqual({
      r: 10,
      g: 10,
      b: 10,
    });
  });

  it("uses the bucket median so stray pixels do not skew the color", () => {
    // 25% 的杂散像素（47）与背景（32）落在同一 4bit 桶：
    // 均值会被拉到 ~36，中位数应保持 32
    const data = fakeImageData(64, 64, (x, y) => (x < 32 && y < 32 ? [47, 47, 47] : [32, 32, 32]));
    expect(ringDominantColor(data, 64, 64, { x: 0, y: 0, width: 0, height: 0 })).toEqual({
      r: 32,
      g: 32,
      b: 32,
    });
  });
});

describe("expandInner", () => {
  it("expands the exclusion rect by pad on all sides", () => {
    const inner = { x: 20, y: 20, width: 40, height: 40 };
    expect(expandInner(inner, 10, 100, 100)).toEqual({
      x: 10,
      y: 10,
      width: 60,
      height: 60,
    });
  });

  it("clamps at the crop edges instead of going negative or overshooting", () => {
    const inner = { x: 4, y: 4, width: 80, height: 80 };
    // pad=10 → x/y 夹到 0；右/下缘 = 原矩形边缘 + pad = 94，未触及裁剪边界不外撑
    expect(expandInner(inner, 10, 100, 100)).toEqual({
      x: 0,
      y: 0,
      width: 94,
      height: 94,
    });
  });
});

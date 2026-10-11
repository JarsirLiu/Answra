import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ambient.ts 纯函数单测：主色统计、BGRA 位图解析、黑帧判定。
 * Electron 的 desktopCapturer/screen 运行时不参与，NativeImage 用假对象替代。
 */

vi.mock("electron", () => ({
  app: { isPackaged: true },
  desktopCapturer: { getSources: vi.fn(async () => []) },
  screen: {
    getAllDisplays: vi.fn(() => [{ id: 1, size: { width: 800, height: 600 }, scaleFactor: 1 }]),
    getPrimaryDisplay: vi.fn(() => ({ id: 1, size: { width: 800, height: 600 }, scaleFactor: 1 })),
    getDisplayMatching: vi.fn(() => ({
      id: 1,
      size: { width: 800, height: 600 },
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    })),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

import { desktopCapturer, screen } from "electron";
import {
  createAmbientThemeController,
  dominantColor,
  expandInner,
  luminanceOf,
  toHex,
} from "../src/main/ambient";

type Bgra = [b: number, g: number, r: number];

/** 构造 BGRA 位图假对象；SAMPLE_STEP=4，尺寸取 4 的倍数。 */
function fakeImage(width: number, height: number, pixel: (x: number, y: number) => Bgra) {
  const buffer = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const [b, g, r] = pixel(x, y);
      buffer[offset] = b;
      buffer[offset + 1] = g;
      buffer[offset + 2] = r;
      buffer[offset + 3] = 255; // alpha
    }
  }
  return { toBitmap: () => buffer } as unknown as Electron.NativeImage;
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

describe("dominantColor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the uniform background color", () => {
    const image = fakeImage(32, 32, () => [40, 40, 200]); // BGRA：B=40 G=40 R=200
    expect(dominantColor(image, 32, 32, { x: 8, y: 8, width: 16, height: 16 })).toEqual({
      r: 200,
      g: 40,
      b: 40,
    });
  });

  it("reads channels in BGRA order (not RGB)", () => {
    const image = fakeImage(32, 32, () => [10, 20, 30]); // B=10 G=20 R=30
    expect(dominantColor(image, 32, 32, { x: 0, y: 0, width: 0, height: 0 })).toEqual({
      r: 30,
      g: 20,
      b: 10,
    });
  });

  it("excludes the window rectangle and picks the ring color behind it", () => {
    // 环形边缘带为红色，窗口自身矩形为蓝色：结果必须是红色
    const image = fakeImage(32, 32, (x, y) => {
      const inWindow = x >= 8 && x < 24 && y >= 8 && y < 24;
      return inWindow ? [255, 0, 0] : [0, 0, 255]; // 蓝窗口 / 红背景
    });
    expect(dominantColor(image, 32, 32, { x: 8, y: 8, width: 16, height: 16 })).toEqual({
      r: 255,
      g: 0,
      b: 0,
    });
  });

  it("rejects near-black screen captures (DRM black frame)", () => {
    const image = fakeImage(32, 32, () => [0, 0, 0]);
    expect(dominantColor(image, 32, 32, { x: 0, y: 0, width: 0, height: 0 })).toBeUndefined();
  });

  it("keeps dark backgrounds that are above the black-frame luminance floor", () => {
    const image = fakeImage(32, 32, () => [10, 10, 10]);
    expect(dominantColor(image, 32, 32, { x: 0, y: 0, width: 0, height: 0 })).toEqual({
      r: 10,
      g: 10,
      b: 10,
    });
  });

  it("uses the bucket median so stray pixels do not skew the color", () => {
    // 25% 的杂散像素（47）与背景（32）落在同一 4bit 桶：
    // 均值会被拉到 ~36，中位数应保持 32
    const image = fakeImage(64, 64, (x, y) => (x < 32 && y < 32 ? [47, 47, 47] : [32, 32, 32]));
    expect(dominantColor(image, 64, 64, { x: 0, y: 0, width: 0, height: 0 })).toEqual({
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

describe("ambient sampling lifecycle", () => {
  it("samples only while enabled", async () => {
    vi.useFakeTimers();
    const window = {
      isDestroyed: () => false,
      isMinimized: () => false,
      getBounds: () => ({ x: 300, y: 200, width: 100, height: 48 }),
      webContents: { send: vi.fn() },
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const controller = createAmbientThemeController(window as never);
    vi.mocked(desktopCapturer.getSources).mockClear();

    await vi.advanceTimersByTimeAsync(8_000);
    expect(desktopCapturer.getSources).not.toHaveBeenCalled();
    expect(screen.on).not.toHaveBeenCalled();

    controller.setEnabled(true);
    await vi.waitFor(() => expect(desktopCapturer.getSources).toHaveBeenCalledOnce());
    expect(screen.on).toHaveBeenCalledWith("display-metrics-changed", expect.any(Function));

    controller.setEnabled(false);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(desktopCapturer.getSources).toHaveBeenCalledOnce();
    expect(screen.removeListener).toHaveBeenCalledWith(
      "display-metrics-changed",
      expect.any(Function),
    );
    expect(window.removeListener).toHaveBeenCalledWith("moved", expect.any(Function));
    controller.dispose();
    vi.useRealTimers();
  });
});

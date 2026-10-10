import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * captureService 纯逻辑单测：坐标换算、捕获重试与权限映射、裁剪编码。
 * Electron 运行时用 mock 替代（desktopCapturer / screen）。
 */

const electronState = vi.hoisted(() => ({
  displays: [] as Array<{
    id: number;
    scaleFactor: number;
    size: { height: number; width: number };
  }>,
  getSources: vi.fn(),
}));

vi.mock("electron", () => ({
  desktopCapturer: { getSources: electronState.getSources },
  screen: {
    getAllDisplays: () => electronState.displays,
    getPrimaryDisplay: () => electronState.displays[0],
  },
}));

import {
  captureDisplay,
  cropToDataUrl,
  logicalToPhysicalRect,
  ScreenCaptureError,
} from "../src/main/capture/captureService";

const DISPLAY = { id: 7, scaleFactor: 2, size: { height: 1080, width: 1920 } };

/** 最小 NativeImage 桩：只实现 captureService 用到的接口。 */
function fakeImage(width: number, height: number, empty = false) {
  return {
    crop: () => fakeImage(width, height, empty),
    getSize: () => ({ height, width }),
    isEmpty: () => empty,
    toDataURL: () => "data:image/png;base64,QUJD",
  };
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("logicalToPhysicalRect", () => {
  it("scales logical rects by the display scale factor", () => {
    expect(logicalToPhysicalRect({ height: 10, width: 20, x: 5, y: 6 }, 2, 3840, 2160)).toEqual({
      height: 20,
      width: 40,
      x: 10,
      y: 12,
    });
  });

  it("clamps the rect into the image bounds", () => {
    expect(
      logicalToPhysicalRect({ height: 500, width: 500, x: 1900, y: 1000 }, 2, 3840, 2160),
    ).toEqual({ height: 160, width: 40, x: 3800, y: 2000 });
  });
});

describe("captureDisplay", () => {
  beforeEach(() => {
    electronState.displays = [DISPLAY];
    electronState.getSources.mockReset();
    setPlatform("win32");
  });

  it("requests physical-resolution thumbnails and matches the display by id", async () => {
    electronState.getSources.mockResolvedValueOnce([
      { display_id: "7", thumbnail: fakeImage(3840, 2160) },
    ]);

    const capture = await captureDisplay(7);
    expect(electronState.getSources).toHaveBeenCalledWith({
      thumbnailSize: { height: 2160, width: 3840 },
      types: ["screen"],
    });
    expect(capture.image.getSize()).toEqual({ height: 2160, width: 3840 });
    expect(capture.scaleFactor).toBe(2);
  });

  it("retries empty frames before succeeding", async () => {
    electronState.getSources
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ display_id: "7", thumbnail: fakeImage(1, 1, true) }])
      .mockResolvedValueOnce([{ display_id: "7", thumbnail: fakeImage(3840, 2160) }]);

    const capture = await captureDisplay(7);
    expect(electronState.getSources).toHaveBeenCalledTimes(3);
    expect(capture.image.isEmpty()).toBe(false);
  });

  it("maps persistent empty frames to permission on macOS", async () => {
    setPlatform("darwin");
    electronState.getSources.mockResolvedValue([]);

    const error = await captureDisplay(7).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ScreenCaptureError);
    expect((error as ScreenCaptureError).reason).toBe("permission");
  });

  it("maps persistent empty frames to unavailable on Windows", async () => {
    electronState.getSources.mockResolvedValue([]);

    const error = await captureDisplay(7).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ScreenCaptureError);
    expect((error as ScreenCaptureError).reason).toBe("unavailable");
  });
});

describe("cropToDataUrl", () => {
  it("crops with physical pixels and returns a PNG data URL", () => {
    const capture = { image: fakeImage(3840, 2160), scaleFactor: 2 };
    const result = cropToDataUrl(capture, { height: 100, width: 100, x: 10, y: 10 });
    expect(result).toEqual({
      dataUrl: "data:image/png;base64,QUJD",
      height: 200,
      ok: true,
      width: 200,
    });
  });

  it("throws ScreenCaptureError when the cropped content is empty", () => {
    const capture = { image: fakeImage(3840, 2160, true), scaleFactor: 1 };
    expect(() => cropToDataUrl(capture, { height: 10, width: 10, x: 0, y: 0 })).toThrowError(
      ScreenCaptureError,
    );
  });
});

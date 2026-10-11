import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * window.ts 纯逻辑单测：隐身能力检测与窗口落位 clamp。
 * Electron 运行时用空 mock 替代（只用到 screen 的显示区数据）。
 */

/** 显示器 mock 数据：800x600 工作区（留出任务栏等），原点在左上。 */
const WORK_AREA = { x: 0, y: 0, width: 800, height: 600 };

vi.mock("electron", () => ({
  app: {},
  BrowserWindow: class {},
  screen: {
    getPrimaryDisplay: () => ({ workArea: WORK_AREA }),
    getDisplayMatching: () => ({ workArea: WORK_AREA }),
  },
}));

/** window.ts 读取 os.release() 判断 Windows build；用可变状态模拟。 */
const osState = vi.hoisted(() => ({ release: "10.0.19045" }));
vi.mock("node:os", () => ({ default: { release: () => osState.release } }));

import {
  clampToWorkArea,
  isStealthSupported,
  positionWindowNearSelection,
} from "../src/main/window";

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("isStealthSupported", () => {
  beforeEach(() => {
    osState.release = "10.0.19045";
  });

  it("supports Windows builds at or above 19041 (WDA_EXCLUDEFROMCAPTURE)", () => {
    setPlatform("win32");
    osState.release = "10.0.19041"; // Windows 10 2004，恰好达到门槛
    expect(isStealthSupported()).toBe(true);
    osState.release = "10.0.19045";
    expect(isStealthSupported()).toBe(true);
    osState.release = "10.0.22631"; // Windows 11
    expect(isStealthSupported()).toBe(true);
  });

  it("rejects Windows builds below 19041 (content protection degrades to black box)", () => {
    setPlatform("win32");
    osState.release = "10.0.17763"; // Windows 10 1809
    expect(isStealthSupported()).toBe(false);
    osState.release = "6.3.9600"; // Windows 8.1
    expect(isStealthSupported()).toBe(false);
    osState.release = "garbage";
    expect(isStealthSupported()).toBe(false);
  });

  it("supports macOS and rejects Linux", () => {
    setPlatform("darwin");
    expect(isStealthSupported()).toBe(true);
    setPlatform("linux");
    expect(isStealthSupported()).toBe(false);
  });
});

describe("clampToWorkArea", () => {
  beforeEach(() => {
    setPlatform("win32");
  });

  it("keeps sizes that already fit the work area", () => {
    expect(clampToWorkArea({ width: 340, height: 60 })).toEqual({ width: 340, height: 60 });
  });

  it("clamps width to the work area minus the fixed margin", () => {
    // 800 - 24 = 776
    expect(clampToWorkArea({ width: 1000, height: 300 })).toEqual({ width: 776, height: 300 });
  });

  it("clamps height to the work area minus the fixed margin", () => {
    // 600 - 24 = 576
    expect(clampToWorkArea({ width: 340, height: 900 })).toEqual({ width: 340, height: 576 });
  });

  it("keeps sizes exactly at the clamp boundary", () => {
    expect(clampToWorkArea({ width: 776, height: 576 })).toEqual({ width: 776, height: 576 });
  });
});

describe("positionWindowNearSelection", () => {
  const WORK_AREA = { x: 0, y: 0, width: 800, height: 600 };

  it("places the window top just below the selection, centered on it", () => {
    expect(
      positionWindowNearSelection(
        { x: 100, y: 100, width: 200, height: 80 },
        { x: 0, y: 0 },
        WORK_AREA,
        { width: 300, height: 60 },
      ),
    ).toEqual({ x: 50, y: 192 });
  });

  it("clamps back into the work area when the selection sits near the edges", () => {
    expect(
      positionWindowNearSelection(
        { x: 650, y: 500, width: 120, height: 80 },
        { x: 0, y: 0 },
        WORK_AREA,
        { width: 300, height: 60 },
      ),
    ).toEqual({ x: 500, y: 540 });
  });

  it("offsets by the display origin on secondary displays", () => {
    expect(
      positionWindowNearSelection(
        { x: 100, y: 100, width: 200, height: 80 },
        { x: 1920, y: 0 },
        { x: 1920, y: 0, width: 1920, height: 1080 },
        { width: 300, height: 60 },
      ),
    ).toEqual({ x: 1970, y: 192 });
  });
});

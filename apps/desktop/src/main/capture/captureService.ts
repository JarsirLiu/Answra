import type { RegionRect, ScreenshotSuccess } from "@answra/shared";
import { desktopCapturer, screen } from "electron";

/** 捕获失败原因，与 shared 的 ScreenshotFailure.reason 对齐。 */
export type CaptureFailureReason = "error" | "permission" | "unavailable";

/** 带原因的捕获错误，编排层据此映射为 ScreenshotFailure。 */
export class ScreenCaptureError extends Error {
  constructor(
    public readonly reason: CaptureFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "ScreenCaptureError";
  }
}

/** 空帧重试上限与退避节奏（与 mycluely 的实践一致：截屏不预检权限，靠空帧判定）。 */
const MAX_ATTEMPTS = 4;

interface DisplayCapture {
  image: Electron.NativeImage;
  /** 显示器缩放比，裁剪时把逻辑选区换算为物理像素。 */
  scaleFactor: number;
}

/**
 * 捕获指定显示器的整屏 NativeImage。
 * macOS 未授予屏幕录制权限时 desktopCapturer 返回空画面，
 * 重试后仍为空则按平台映射为 permission（darwin）或 unavailable。
 */
export async function captureDisplay(displayId: number): Promise<DisplayCapture> {
  const display =
    screen.getAllDisplays().find((candidate) => candidate.id === displayId) ??
    screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const scaleFactor = display.scaleFactor > 0 ? display.scaleFactor : 1;
  // thumbnailSize 用物理像素请求，保证 1:1 分辨率（Retina/缩放屏不失真）
  const thumbnailSize = {
    width: Math.round(width * scaleFactor),
    height: Math.round(height * scaleFactor),
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const sources = await desktopCapturer.getSources({ thumbnailSize, types: ["screen"] });
    const source =
      sources.find((candidate) => String(candidate.display_id ?? "") === String(displayId)) ??
      sources[0];
    const image = source?.thumbnail;
    if (image && !image.isEmpty()) return { image, scaleFactor };

    if (attempt < MAX_ATTEMPTS) await delay(Math.min(750, attempt * 250));
  }

  if (process.platform === "darwin") {
    throw new ScreenCaptureError(
      "permission",
      "未获得屏幕录制权限，请在 系统设置 › 隐私与安全性 › 屏幕录制 中允许本应用",
    );
  }
  throw new ScreenCaptureError("unavailable", "没有可用的屏幕画面");
}

/** 把逻辑像素选区换算为物理像素，并 clamp 到图像边界内。导出供测试。 */
export function logicalToPhysicalRect(
  rect: RegionRect,
  scaleFactor: number,
  maxWidth: number,
  maxHeight: number,
): RegionRect {
  const scale = scaleFactor > 0 ? scaleFactor : 1;
  const x = clamp(Math.round(rect.x * scale), 0, maxWidth);
  const y = clamp(Math.round(rect.y * scale), 0, maxHeight);
  const width = clamp(Math.round(rect.width * scale), 1, maxWidth - x);
  const height = clamp(Math.round(rect.height * scale), 1, maxHeight - y);
  return { height, width, x, y };
}

/** 裁剪选区并编码为 PNG data URL（物理像素尺寸）。 */
export function cropToDataUrl(capture: DisplayCapture, rect: RegionRect): ScreenshotSuccess {
  const { width: imageWidth, height: imageHeight } = capture.image.getSize();
  const physical = logicalToPhysicalRect(rect, capture.scaleFactor, imageWidth, imageHeight);
  const cropped = capture.image.crop(physical);
  if (cropped.isEmpty()) {
    throw new ScreenCaptureError("error", "截图内容为空，请保持目标页面可见后重试");
  }
  return {
    dataUrl: cropped.toDataURL(),
    height: physical.height,
    ok: true,
    width: physical.width,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { AmbientChannels, type AmbientColorPayload } from "@answra/shared";
import { type BrowserWindow, desktopCapturer, screen } from "electron";

/**
 * 变色龙主题：采样悬浮条周边的屏幕背景主色并推送给渲染器。
 *
 * 采样原理：用 desktopCapturer 截取整个显示器（降采样），裁出窗口
 * bounds 外扩一圈的区域，统计时排除窗口自身覆盖的矩形，只取环形
 * 边缘带——这样不需要隐藏窗口即可拿到"身后"的背景色，无闪烁。
 *
 * 采样时机：窗口移动（节流）、显示器变化、低频轮询（背景内容会变）。
 */

/** 窗口 bounds 外扩的 CSS 像素，保证环形采样带有足够样本。 */
const RING_PAD = 48;
/** 位图遍历步长（裁剪图内的像素间隔），控制统计成本。 */
const SAMPLE_STEP = 4;
/** 窗口移动采样的节流间隔。 */
const MOVE_THROTTLE_MS = 400;
/** 轮询间隔：背景内容变化（如翻页）后跟随刷新。 */
const POLL_INTERVAL_MS = 4000;
/** 主色占比超过该阈值且接近纯黑时，视为截屏黑帧（DRM/策略），判定失败。 */
const BLACK_FRAME_RATIO = 0.98;

interface AmbientColor {
  r: number;
  g: number;
  b: number;
}

/** 相对亮度（sRGB 加权，0~1）。导出供测试。 */
export function luminanceOf({ r, g, b }: AmbientColor): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function toHex({ r, g, b }: AmbientColor): string {
  const part = (value: number) => value.toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/**
 * 从裁剪位图的环形区域（排除窗口自身矩形）统计主色。
 * 颜色按 4bit/通道 量化分桶，取最大桶的均值。导出供测试。
 */
export function dominantColor(
  bitmap: Electron.NativeImage,
  width: number,
  height: number,
  inner: { x: number; y: number; width: number; height: number },
): AmbientColor | undefined {
  const buffer = bitmap.toBitmap();
  // Electron 位图默认为 BGRA 排列
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  let total = 0;

  for (let y = 0; y < height; y += SAMPLE_STEP) {
    for (let x = 0; x < width; x += SAMPLE_STEP) {
      const inWindow =
        x >= inner.x && x < inner.x + inner.width && y >= inner.y && y < inner.y + inner.height;
      if (inWindow) continue;
      const offset = (y * width + x) * 4;
      const b = buffer[offset] ?? 0;
      const g = buffer[offset + 1] ?? 0;
      const r = buffer[offset + 2] ?? 0;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
      bucket.count += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      buckets.set(key, bucket);
      total += 1;
    }
  }

  let best: { count: number; r: number; g: number; b: number } | undefined;
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) best = bucket;
  }
  if (!best || !total) return undefined;

  if (best.count / total > BLACK_FRAME_RATIO) {
    const avg = { r: best.r / best.count, g: best.g / best.count, b: best.b / best.count };
    if (luminanceOf(avg) < 0.02) return undefined;
  }

  return {
    r: Math.round(best.r / best.count),
    g: Math.round(best.g / best.count),
    b: Math.round(best.b / best.count),
  };
}

/** 采样一次并推送；任何失败都推送 ok=false，由渲染器回落默认主题。 */
async function sampleAndPush(window: BrowserWindow): Promise<void> {
  let payload: AmbientColorPayload;
  try {
    if (window.isDestroyed() || window.isMinimized()) return;
    const bounds = window.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const displayBounds = display.bounds;

    const region = {
      x: Math.max(displayBounds.x, bounds.x - RING_PAD),
      y: Math.max(displayBounds.y, bounds.y - RING_PAD),
      width: 0,
      height: 0,
    };
    region.width = Math.min(
      displayBounds.x + displayBounds.width - region.x,
      bounds.width + RING_PAD * 2,
    );
    region.height = Math.min(
      displayBounds.y + displayBounds.height - region.y,
      bounds.height + RING_PAD * 2,
    );
    if (region.width <= 0 || region.height <= 0) return;

    // 缩略图按显示器 CSS 尺寸的一半请求，兼顾精度与开销
    const thumbnailSize = {
      width: Math.max(1, Math.round(display.size.width / 2)),
      height: Math.max(1, Math.round(display.size.height / 2)),
    };
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
    const screenSource =
      sources.find((source) => source.display_id === String(display.id)) ?? sources[0];
    const thumbnail = screenSource?.thumbnail;
    if (!thumbnail || thumbnail.isEmpty()) return;

    const thumbSize = thumbnail.getSize();
    const thumbScale = thumbSize.width / display.size.width;
    const cropX = Math.round((region.x - displayBounds.x) * thumbScale);
    const cropY = Math.round((region.y - displayBounds.y) * thumbScale);
    const cropped = thumbnail.crop({
      x: cropX,
      y: cropY,
      width: Math.min(Math.round(region.width * thumbScale), thumbSize.width - cropX),
      height: Math.min(Math.round(region.height * thumbScale), thumbSize.height - cropY),
    });

    const { width, height } = cropped.getSize();
    // 窗口自身矩形在裁剪图内的位置（缩略图坐标系），统计时排除
    const inner = {
      x: Math.round((bounds.x - region.x) * thumbScale),
      y: Math.round((bounds.y - region.y) * thumbScale),
      width: Math.round(bounds.width * thumbScale),
      height: Math.round(bounds.height * thumbScale),
    };
    const color = dominantColor(cropped, width, height, inner);
    payload = color
      ? { ok: true, hex: toHex(color), luminance: luminanceOf(color) }
      : { ok: false, hex: "#ffffff", luminance: 1 };
  } catch {
    payload = { ok: false, hex: "#ffffff", luminance: 1 };
  }
  if (!window.isDestroyed()) {
    window.webContents.send(AmbientChannels.AmbientColor, payload);
  }
}

/** 启动变色龙采样：绑定窗口移动/显示器变化/轮询，返回清理函数。 */
export function startAmbientTheme(window: BrowserWindow): () => void {
  let lastRun = 0;
  let pending = false;
  let disposed = false;

  const schedule = () => {
    if (disposed) return;
    const now = Date.now();
    if (now - lastRun < MOVE_THROTTLE_MS) {
      if (!pending) {
        pending = true;
        setTimeout(
          () => {
            pending = false;
            lastRun = Date.now();
            void sampleAndPush(window);
          },
          MOVE_THROTTLE_MS - (now - lastRun),
        );
      }
      return;
    }
    lastRun = now;
    void sampleAndPush(window);
  };

  const poll = setInterval(schedule, POLL_INTERVAL_MS);
  screen.on("display-metrics-changed", schedule);
  window.on("moved", schedule);
  window.once("ready-to-show", schedule);

  return () => {
    disposed = true;
    clearInterval(poll);
    screen.removeListener("display-metrics-changed", schedule);
  };
}

import { AmbientChannels, type AmbientColorPayload } from "@answra/shared";
import { app, type BrowserWindow, desktopCapturer, screen } from "electron";

/**
 * 变色龙主题：采样悬浮条周边的屏幕背景主色并推送给渲染器。
 *
 * 采样原理：用 desktopCapturer 截取整个显示器（降采样），裁出窗口
 * bounds 外扩一圈的区域，统计时排除窗口自身矩形再外扩一圈投影带
 * （悬浮条的 drop shadow 会压暗紧贴 bounds 的屏幕像素），只取更外侧
 * 的环形边缘带——这样不需要隐藏窗口即可拿到"身后"的背景色，无闪烁。
 *
 * 采样时机：窗口移动（节流）、显示器变化、低频轮询（背景内容会变）。
 */

/** 窗口 bounds 外扩的 CSS 像素，保证环形采样带有足够样本。 */
const RING_PAD = 48;
/** 采样排除矩形在窗口 bounds 基础上再外扩的 CSS 像素。
 *  窗口 hasShadow=false 无系统投影；CSS 阴影只渲染进窗口自身约 8px
 *  的透明 padding（超出即被窗口裁剪），外扩 12px 即可绕开边缘杂散像素。
 *  注意：采样环必须紧贴窗口——环越宽越容易混入周边无关区域
 *  （如编辑器更深色的侧栏/终端面板），导致主色偏离"正后方"的背景。 */
const SHADOW_PAD = 12;
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
 * 将窗口排除矩形向外扩 pad 像素，并夹紧在裁剪图内。
 * 用于绕开窗口自身投影压暗的屏幕像素，避免主色被"染黑"。导出供测试。
 */
export function expandInner(
  inner: { x: number; y: number; width: number; height: number },
  pad: number,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, inner.x - pad);
  const y = Math.max(0, inner.y - pad);
  return {
    x,
    y,
    width: Math.min(width - x, inner.width + (inner.x - x) + pad),
    height: Math.min(height - y, inner.height + (inner.y - y) + pad),
  };
}

/**
 * 从裁剪位图的环形区域（排除窗口自身矩形）统计主色。
 * 颜色按 4bit/通道 量化分桶，取最大桶的中位数（均值会被桶内少量
 * 偏暗/偏亮的杂散像素拉偏，中位数更贴近桶的真实主色）。导出供测试。
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

  let bestKey = -1;
  let best: { count: number; r: number; g: number; b: number } | undefined;
  for (const [key, bucket] of buckets) {
    if (!best || bucket.count > best.count) {
      best = bucket;
      bestKey = key;
    }
  }
  if (!best || !total) return undefined;

  if (best.count / total > BLACK_FRAME_RATIO) {
    const avg = { r: best.r / best.count, g: best.g / best.count, b: best.b / best.count };
    if (luminanceOf(avg) < 0.02) return undefined;
  }

  // 第二遍收集最大桶成员的通道值，取每通道中位数
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (let y = 0; y < height; y += SAMPLE_STEP) {
    for (let x = 0; x < width; x += SAMPLE_STEP) {
      const inWindow =
        x >= inner.x && x < inner.x + inner.width && y >= inner.y && y < inner.y + inner.height;
      if (inWindow) continue;
      const offset = (y * width + x) * 4;
      const b = buffer[offset] ?? 0;
      const g = buffer[offset + 1] ?? 0;
      const r = buffer[offset + 2] ?? 0;
      if ((((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)) !== bestKey) continue;
      rs.push(r);
      gs.push(g);
      bs.push(b);
    }
  }

  return { r: median(rs), g: median(gs), b: median(bs) };
}

/** 中位数（偶数个取中间两值均值后四舍五入）。 */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? (sorted[mid] ?? 0)
    : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

/** 整帧平均亮度（0~1）：用于诊断截屏是否整体发黑。 */
function frameLuminance(bitmap: Electron.NativeImage): number {
  const { width, height } = bitmap.getSize();
  if (!width || !height) return 0;
  const buffer = bitmap.toBitmap();
  let sum = 0;
  let count = 0;
  for (let y = 0; y < height; y += 8) {
    for (let x = 0; x < width; x += 8) {
      const offset = (y * width + x) * 4;
      const b = buffer[offset] ?? 0;
      const g = buffer[offset + 1] ?? 0;
      const r = buffer[offset + 2] ?? 0;
      sum += luminanceOf({ r, g, b });
      count += 1;
    }
  }
  return count > 0 ? sum / count : 0;
}

/** 整帧最主色（4bit 分桶众数中位数）及其占比：用于区分"整帧近黑"与"仅环带采样错位"。 */
function frameDominant(bitmap: Electron.NativeImage): { hex: string; share: number } {
  const { width, height } = bitmap.getSize();
  if (!width || !height) return { hex: "#000000", share: 0 };
  const buffer = bitmap.toBitmap();
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  let total = 0;
  for (let y = 0; y < height; y += SAMPLE_STEP) {
    for (let x = 0; x < width; x += SAMPLE_STEP) {
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
  if (!best || !total) return { hex: "#000000", share: 0 };
  const r = Math.round(best.r / best.count);
  const g = Math.round(best.g / best.count);
  const b = Math.round(best.b / best.count);
  return { hex: toHex({ r, g, b }), share: best.count / total };
}

/** 诊断：最近一次推送的采样结果签名，变化时才打印，避免刷屏。 */
let lastLoggedSignature: string | undefined;

/** 采样一次并推送；任何失败都推送 ok=false，由渲染器回落默认主题。 */
async function sampleAndPush(window: BrowserWindow): Promise<void> {
  let payload: AmbientColorPayload;
  let diagnostic = "no-run";
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
    const matchedSource = sources.find((source) => source.display_id === String(display.id));
    const screenSource = matchedSource ?? sources[0];
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
    const color = dominantColor(
      cropped,
      width,
      height,
      // 排除矩形外扩投影带：悬浮条自身的 drop shadow 会压暗紧贴 bounds 的像素
      expandInner(inner, Math.round(SHADOW_PAD * thumbScale), width, height),
    );
    payload = color
      ? { ok: true, hex: toHex(color), luminance: luminanceOf(color) }
      : { ok: false, hex: "#ffffff", luminance: 1 };
    // 诊断信息：截屏源匹配 + 整帧主色/亮度（区分"整帧近黑"与"仅环带采样错位"）
    const frame = frameDominant(thumbnail);
    diagnostic =
      `sources=${sources.length} matched=${matchedSource ? "yes" : "no"} ` +
      `thumb=${thumbnail.getSize().width}x${thumbnail.getSize().height} ` +
      `fullLum=${frameLuminance(thumbnail).toFixed(3)} ` +
      `fDom=${frame.hex} fShare=${frame.share.toFixed(2)}`;
  } catch (error) {
    payload = { ok: false, hex: "#ffffff", luminance: 1 };
    diagnostic = `error:${error instanceof Error ? error.message : String(error)}`;
  }
  if (!window.isDestroyed()) {
    // 开发期诊断：打印采样结果与截屏源信息（变化时），便于核对取色链路
    const signature = `${diagnostic} -> ${payload.ok ? payload.hex : "unavailable"}`;
    if (!app.isPackaged && signature !== lastLoggedSignature) {
      lastLoggedSignature = signature;
      console.log(`[answra:ambient] ${signature}`);
    }
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

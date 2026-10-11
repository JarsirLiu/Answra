/**
 * 变色龙环形取色的纯函数（渲染端 WGC canvas 版，v2 首选路径）。
 *
 * 算法与主进程 v1（apps/desktop/src/main/ambient.ts）保持一致：
 * 颜色按 4bit/通道 量化分桶取最大桶，桶内取每通道中位数。
 * 唯一差异是数据源：canvas ImageData 为 RGBA 字节序
 * （主进程 NativeImage.toBitmap 为 BGRA）。
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 位图遍历步长（像素间隔），控制统计成本。 */
const SAMPLE_STEP = 4;
/** 主色占比超过该阈值且接近纯黑时，视为截屏黑帧（DRM/策略），判定失败。 */
const BLACK_FRAME_RATIO = 0.98;

/** 相对亮度（sRGB 加权，0~1）。 */
export function luminanceOf({ r, g, b }: Rgb): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function toHex({ r, g, b }: Rgb): string {
  const part = (value: number) => value.toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/**
 * 将窗口排除矩形向外扩 pad 像素，并夹紧在裁剪图内。
 * 用于绕开窗口自身投影压暗的屏幕像素，避免主色被"染黑"。
 */
export function expandInner(inner: Rect, pad: number, width: number, height: number): Rect {
  const x = Math.max(0, inner.x - pad);
  const y = Math.max(0, inner.y - pad);
  return {
    x,
    y,
    width: Math.min(width - x, inner.width + (inner.x - x) + pad),
    height: Math.min(height - y, inner.height + (inner.y - y) + pad),
  };
}

/** 中位数（偶数个取中间两值均值后四舍五入）。 */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? (sorted[mid] ?? 0)
    : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

/**
 * 从 RGBA 位图的环形区域（排除窗口自身矩形）统计主色。
 * @param data ImageData.data（RGBA 字节序）
 * @param inner 排除矩形（窗口 + 投影带，已换算到本位图坐标系）
 */
export function ringDominantColor(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  inner: Rect,
): Rgb | undefined {
  const keyOf = (r: number, g: number, b: number) => ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  let total = 0;

  for (let y = 0; y < height; y += SAMPLE_STEP) {
    for (let x = 0; x < width; x += SAMPLE_STEP) {
      const inWindow =
        x >= inner.x && x < inner.x + inner.width && y >= inner.y && y < inner.y + inner.height;
      if (inWindow) continue;
      const offset = (y * width + x) * 4;
      const r = data[offset] ?? 0;
      const g = data[offset + 1] ?? 0;
      const b = data[offset + 2] ?? 0;
      const key = keyOf(r, g, b);
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
      const r = data[offset] ?? 0;
      const g = data[offset + 1] ?? 0;
      const b = data[offset + 2] ?? 0;
      if (keyOf(r, g, b) !== bestKey) continue;
      rs.push(r);
      gs.push(g);
      bs.push(b);
    }
  }

  return { r: median(rs), g: median(gs), b: median(bs) };
}

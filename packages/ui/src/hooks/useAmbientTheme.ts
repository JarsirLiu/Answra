/**
 * 变色龙主题（ambient variant）：订阅主进程的背景主色推送，
 * 只把**表面固有色**（胶囊/面板/纸面）换成背景主色，让悬浮层贴着桌面背景坐；
 * 文字、图标、控件描边、交互态、强调色一律沿用 `[data-theme]` 调色板的实色。
 *
 * 为什么不调文字对比度：早期版本按「隐蔽强度」把文字色往背景里混，结果是灰雾字——
 * 低对比的 12px 中文在浅底上看起来既糊又不舒服。真正暴露悬浮层的是深色投影和
 * 矩形轮廓，不是文字本身，所以现在表面融底、文字保持调色板实色。
 *
 * 因此变色龙的隐蔽手段只有两条，都不牺牲近距离可读性：
 * 1. 表面固有色换成背景主色（不出现与背景不同的色块）；
 * 2. 结构轮廓与投影归零（`--line-base`/`--line-soft-base`/`--shadow-*`）：
 *    面板与胶囊不再有"矩形感"，但它们内部没有大字号内容，近看照样干净；
 *    控件描边 `--edge-*` 不归零——输入框/开关/滑杆的边界必须看得见。
 * 感知令牌的 fade 公式只存在于 tokens.css；本 hook 只换参数不换公式。
 */

/** 背景亮度低于该阈值判定为深色背景，切 dark 调色板。 */
const DARK_THRESHOLD = 0.5;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function parseHex(hex: string): Rgb | undefined {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  const digits = match?.[1];
  if (!digits) return undefined;
  const value = Number.parseInt(digits, 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** 空格分隔的 RGB 通道值，对应 tokens.css 的 -tint 原始参数格式。 */
function toChannels({ r, g, b }: Rgb): string {
  return `${clamp(r)} ${clamp(g)} ${clamp(b)}`;
}

/** 向目标色（黑/白）混合，amount 为混合比例 0~1。 */
function mix(color: Rgb, target: Rgb, amount: number): Rgb {
  return {
    r: color.r + (target.r - color.r) * amount,
    g: color.g + (target.g - color.g) * amount,
    b: color.b + (target.b - color.b) * amount,
  };
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** 令牌名 → 值；null 表示移除该内联覆盖，回落样式表默认。 */
export type AmbientTokens = Record<string, string | null>;

/** 线性化 sRGB 通道亮度（WCAG 定义），用于深浅方案判定。 */
function channelLuminance(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/**
 * 判定背景对应的主题方案：深色背景→dark，浅色背景→light。
 * useAppTheme 据此写 data-theme，让变色龙与 [data-theme] 令牌组联动，
 * 而不是各自为战。
 */
export function resolveAmbientScheme(hex: string): "light" | "dark" | undefined {
  const bg = parseHex(hex);
  if (!bg) return undefined;
  return relativeLuminance(bg) < DARK_THRESHOLD ? "dark" : "light";
}

/**
 * 带滞回的深浅判定：背景亮度在 0.5 阈值附近时，朴素判定会随采样噪声
 * 反复翻转 data-theme，表现为全窗口明暗闪烁。规则：维持现状，直到
 * 亮度越过阈值 ±0.07 的滞回带才翻转；无历史判定时沿用朴素阈值。
 */
export function resolveAmbientSchemeHysteresis(
  hex: string,
  previous: "light" | "dark" | undefined,
): "light" | "dark" | undefined {
  const bg = parseHex(hex);
  if (!bg) return undefined;
  const luminance = relativeLuminance(bg);
  if (previous === "dark") return luminance < DARK_THRESHOLD + SCHEME_HYSTERESIS ? "dark" : "light";
  if (previous === "light")
    return luminance < DARK_THRESHOLD - SCHEME_HYSTERESIS ? "dark" : "light";
  return luminance < DARK_THRESHOLD ? "dark" : "light";
}

/** 深浅滞回带宽：亮度越过 DARK_THRESHOLD ± 该值才翻转方案。 */
const SCHEME_HYSTERESIS = 0.07;

/**
 * 由背景主色派生 ambient variant 的「原始参数」：表面固有色 + 结构轮廓/投影归零。
 *
 * - 胶囊与面板取背景主色原色：悬浮层贴着桌面背景坐，不靠调暗文字来伪装。
 * - 纸面（面板内的纸面容器）比背景稍向调色板纸色靠一档，保证层内层次。
 * - 文字 / 图标 / 控件描边 / 交互态 / 强调色一概不写：它们来自 `[data-theme]`
 *   调色板的实色（`resolveAmbientScheme` 按背景亮度选择浅色或深色调色板），
 *   因此任何背景下文字都是干净的实色，不会出现灰雾字。
 * - 结构轮廓（--line-base/--line-soft-base）与投影（--shadow-base/--shadow-ctl-base）
 *   归零：这是"远距离/照片不易发现"的主要手段，对近距离可读性零影响。
 *   控件描边 `--edge-*` 保持调色板值，输入框/开关/滑杆的边界永远可见。
 *
 * 硬约束：不写任何表面 alpha（表面恒不透明，背景零参与混色，颜色不随拖动抖动）。
 */
export function deriveAmbientTokens(hex: string): AmbientTokens | undefined {
  const bg = parseHex(hex);
  if (!bg) return undefined;
  const isDark = relativeLuminance(bg) < DARK_THRESHOLD;
  const extreme = isDark ? WHITE : BLACK;
  const paper = mix(bg, extreme, isDark ? 0.06 : 0.1);

  return {
    "--glass-tint": toChannels(bg),
    // 胶囊与面板是同一悬浮组件的两层：固有色必须完全一致（不可有微层次差），
    // 层级感交给描边与投影表达
    "--panel-tint": toChannels(bg),
    "--paper-tint": toChannels(paper),
    // 结构轮廓与投影归零：悬浮层的"矩形感"是远距离最先被认出的信号
    "--line-base": "0",
    "--line-soft-base": "0",
    "--shadow-base": "0",
    "--shadow-ctl-base": "0",
  };
}

/** 所有主题写入方可能覆盖的全部原始参数；关闭跟随/清除覆盖时逐一移除回落默认主题。 */
export const FALLBACK_TOKEN_KEYS = [
  "--ink-tint",
  "--icon-tint",
  "--glass-tint",
  "--glass-base",
  "--panel-tint",
  "--panel-base",
  "--line-tint",
  "--line-base",
  "--line-soft-base",
  "--edge-tint",
  "--edge-base",
  "--edge-strong-base",
  "--hover-tint",
  "--hover-base",
  "--field-tint",
  "--field-base",
  "--focus-tint",
  "--focus-base",
  "--paper-tint",
  "--danger-tint",
  "--scrim-base",
  "--shadow-base",
  "--shadow-ctl-base",
  "--mint-tint",
  "--mint-deep-tint",
  "--mint-text-tint",
  "--mint-wash-base",
];

/** 令牌写入器：null 表示移除内联覆盖回落样式表默认；undefined 整体清除。 */
export function applyTokens(tokens: AmbientTokens | undefined): void {
  const rootStyle = document.documentElement.style;
  if (!tokens) {
    for (const key of FALLBACK_TOKEN_KEYS) rootStyle.removeProperty(key);
    return;
  }
  for (const [key, value] of Object.entries(tokens)) {
    if (value === null) rootStyle.removeProperty(key);
    else rootStyle.setProperty(key, value);
  }
}

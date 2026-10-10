/**
 * 变色龙主题（ambient variant）：订阅主进程的背景主色推送，
 * 重算「原始参数」（-tint 通道 / -base alpha）写入 :root 内联样式。
 * 感知令牌的 fade 公式只存在于 tokens.css；本 hook 只换参数不换公式，
 * 保证「跟随背景」与「用户透明度」两个自由度互不干扰。
 */

/** 背景亮度低于该阈值判定为深色背景，文字切浅色。 */
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

/** 品牌薄荷绿（与 styles/tokens.css 的 --mint 保持一致，仅取色相派生文字色）。 */
const MINT: Rgb = { r: 47, g: 161, b: 113 };

/** 文字/图标对背景的最低对比度（WCAG AA 正文级）。 */
const TARGET_CONTRAST = 4.5;

/** 线性化 sRGB 通道亮度（WCAG 定义），用于对比度计算。 */
function channelLuminance(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** WCAG 对比度（1~21）。 */
function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * 从背景向黑/白方向逐步加深文字色，取第一个满足对比度要求的值；
 * 保证任何背景色下功能入口、AI 回复都可读，不会"扎眼也看不清"。
 */
function chooseInk(bg: Rgb, isDark: boolean): Rgb {
  const extreme = isDark ? WHITE : BLACK;
  for (let amount = isDark ? 0.55 : 0.5; amount <= 1; amount += 0.05) {
    const candidate = mix(bg, extreme, amount);
    if (contrastRatio(candidate, bg) >= TARGET_CONTRAST) return candidate;
  }
  return extreme;
}

/** 深色背景下把品牌绿提亮到可读；浅色背景返回 undefined 保留默认深绿。 */
function chooseMintText(bg: Rgb): Rgb | undefined {
  if (relativeLuminance(bg) >= DARK_THRESHOLD) return undefined;
  for (let amount = 0.25; amount <= 0.85; amount += 0.05) {
    const candidate = mix(MINT, WHITE, amount);
    if (contrastRatio(candidate, bg) >= TARGET_CONTRAST) return candidate;
  }
  return undefined;
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
 * 由背景主色派生 ambient variant 的「原始参数」（仅 tint 通道与前景 alpha 基数）。
 * 感知令牌（--ink/--glass/...）的 fade 公式仍在 tokens.css，本函数只换参数不换公式。
 * 硬约束：不写任何表面 alpha（表面恒不透明，背景零参与混色，颜色不随拖动抖动）。
 * 深色背景：文字向白色求解到对比度达标，面板为加深一档的背景色，品牌绿同步提亮；
 * 浅色背景：文字向黑色求解，面板为向白色提亮一档的背景色。
 */
export function deriveAmbientTokens(hex: string): AmbientTokens | undefined {
  const bg = parseHex(hex);
  if (!bg) return undefined;
  const isDark = relativeLuminance(bg) < DARK_THRESHOLD;
  const extreme = isDark ? WHITE : BLACK;
  const ink = chooseInk(bg, isDark);
  const mintText = chooseMintText(bg);
  const paper = mix(bg, extreme, isDark ? 0.12 : 0.1);
  const inkSoft = mix(ink, bg, 0.12);
  // 面板（不透明表面）：深色背景再压暗一档、浅色背景向白提亮一档，
  // 与背景保持同色相的同时留出表面层次
  const panel = isDark ? mix(bg, BLACK, 0.22) : mix(bg, WHITE, 0.86);

  return {
    "--ink-tint": toChannels(ink),
    "--icon-tint": toChannels(inkSoft),
    "--glass-tint": toChannels(bg),
    "--panel-tint": toChannels(panel),
    "--line-tint": toChannels(ink),
    "--hover-tint": toChannels(ink),
    "--hover-base": "0.16",
    "--field-tint": toChannels(ink),
    "--field-base": "0.09",
    "--focus-tint": toChannels(ink),
    "--focus-base": "0.5",
    "--paper-tint": toChannels(paper),
    // 品牌绿文字与激活底色：浅色背景不覆盖（默认深绿在浅底上可读）
    "--mint-text-tint": mintText ? toChannels(mintText) : null,
    "--mint-wash-base": mintText ? "0.3" : null,
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
  "--hover-tint",
  "--hover-base",
  "--field-tint",
  "--field-base",
  "--focus-tint",
  "--focus-base",
  "--paper-tint",
  "--danger-tint",
  "--scrim-base",
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

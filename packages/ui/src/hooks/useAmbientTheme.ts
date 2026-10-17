/**
 * 变色龙主题（ambient variant）：订阅主进程的背景主色推送，
 * 重算「原始参数」（-tint 通道 / -base alpha）写入 :root 内联样式。
 * 感知令牌的 fade 公式只存在于 tokens.css；本 hook 只换参数不换公式，
 * 保证「跟随背景」与「用户透明度」两个自由度互不干扰。
 */

import { type AmbientVeilLevel, DEFAULT_AMBIENT_VEIL } from "../model";

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

/**
 * 隐蔽强度档位的对比度与柔化参数。
 *
 * 视觉原理：人眼的空间分辨率随距离下降，而对比敏感度在高空间频率处陡降，
 * 因此「小字号 + 中低对比」在近距离可读、远距离直接掉出可见阈值；相机/缩略图
 * 又把低亮度差的小字当作噪声抹平。所以档位调的是对比度目标，不是字号字重。
 */
const VEIL_PROFILES: Record<
  AmbientVeilLevel,
  { text: number; accent: number; accentMix: number; iconMix: number; wash: number }
> = {
  // 贴得最紧：只有近距离刻意去看才读得出
  blend: { text: 1.4, accent: 1.25, accentMix: 0.7, iconMix: 0.22, wash: 0.1 },
  // 默认：静置融进背景，一臂距离内可读
  veiled: { text: 2, accent: 1.5, accentMix: 0.65, iconMix: 0.18, wash: 0.12 },
  balanced: { text: 3, accent: 2, accentMix: 0.6, iconMix: 0.15, wash: 0.16 },
  // 无障碍兜底：WCAG AA 正文级对比度
  readable: { text: 4.5, accent: 3, accentMix: 0.55, iconMix: 0.12, wash: 0.22 },
};

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

/** 向 extreme 方向逐步混合，取第一个达到目标对比度的值；全程达不到则返回 undefined。 */
function solveInk(bg: Rgb, extreme: Rgb, target: number): Rgb | undefined {
  for (let amount = 0; amount <= 1; amount += 0.02) {
    const candidate = mix(bg, extreme, amount);
    if (contrastRatio(candidate, bg) >= target) return candidate;
  }
  return undefined;
}

/**
 * 求文字色：目标对比度来自隐蔽强度档位。
 * 先按深浅方案的方向（深底提亮、浅底压暗）求解；该方向物理上够不到目标时
 * （中亮度背景向亮端最多只能到 ~3:1）改用反方向——否则 readable 档会在
 * 中亮度背景上悄悄失效，只剩形似 4.5:1 的名字。
 */
function chooseInk(bg: Rgb, isDark: boolean, target: number): Rgb {
  const preferred = isDark ? WHITE : BLACK;
  const alternate = isDark ? BLACK : WHITE;
  return solveInk(bg, preferred, target) ?? solveInk(bg, alternate, target) ?? preferred;
}

/**
 * 品牌绿降饱和为"灰绿"强调色：先按档位把高饱和抹掉（档位越低越贴近背景），
 * 再按需向黑/白求解到目标对比度；观感克制，不与页面抢眼。
 */
function chooseAccent(bg: Rgb, isDark: boolean, target: number, mixAmount: number): Rgb {
  const muted = mix(MINT, bg, mixAmount);
  const extreme = isDark ? WHITE : BLACK;
  for (let amount = 0; amount <= 0.9; amount += 0.05) {
    const candidate = mix(muted, extreme, amount);
    if (contrastRatio(candidate, bg) >= target) return candidate;
  }
  return muted;
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
 * 由背景主色派生 ambient variant 的「原始参数」（仅 tint 通道、前景 alpha 基数与投影基数）。
 * 感知令牌（--ink/--glass/...）的 fade 公式仍在 tokens.css，本函数只换参数不换公式。
 * 硬约束：不写任何表面 alpha（表面恒不透明，背景零参与混色，颜色不随拖动抖动）。
 *
 * 隐蔽原则：表面与描边都取背景原色、投影打到 0——远距离和拍照最先暴露悬浮层的
 * 就是深色投影与矩形描边；前景对比度由 `veil` 档位决定，静置时贴近背景，
 * 近距离仍可读，需要无障碍时可切到 readable 档。
 * @param veil 隐蔽强度档位；缺省为 DEFAULT_AMBIENT_VEIL
 */
export function deriveAmbientTokens(
  hex: string,
  veil: AmbientVeilLevel = DEFAULT_AMBIENT_VEIL,
): AmbientTokens | undefined {
  const bg = parseHex(hex);
  if (!bg) return undefined;
  const profile = VEIL_PROFILES[veil];
  const isDark = relativeLuminance(bg) < DARK_THRESHOLD;
  const extreme = isDark ? WHITE : BLACK;
  const ink = chooseInk(bg, isDark, profile.text);
  const accent = chooseAccent(bg, isDark, profile.accent, profile.accentMix);
  const paper = mix(bg, extreme, isDark ? 0.06 : 0.1);
  const inkSoft = mix(ink, bg, profile.iconMix);

  return {
    "--ink-tint": toChannels(ink),
    "--icon-tint": toChannels(inkSoft),
    "--glass-tint": toChannels(bg),
    // 胶囊与面板是同一悬浮组件的两层：固有色必须完全一致（不可有微层次差），
    // 层级感交给描边与投影表达
    "--panel-tint": toChannels(bg),
    // 描边取背景色：变色龙下不画矩形轮廓，边界只由内容本身表达
    "--line-tint": toChannels(bg),
    "--hover-tint": toChannels(ink),
    "--hover-base": "0.1",
    "--field-tint": toChannels(ink),
    "--field-base": "0.06",
    "--focus-tint": toChannels(ink),
    "--focus-base": "0.35",
    "--paper-tint": toChannels(paper),
    // 强调色整体降饱和：文字/图标/激活底统一灰绿，不再出现高饱和亮绿
    "--mint-tint": toChannels(accent),
    "--mint-deep-tint": toChannels(mix(accent, extreme, 0.2)),
    "--mint-text-tint": toChannels(accent),
    "--mint-wash-base": String(profile.wash),
    // 投影是远距离最先暴露悬浮条的信号：变色龙下彻底关掉
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

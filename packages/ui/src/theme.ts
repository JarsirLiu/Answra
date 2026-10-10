import type { DesktopBridge } from "@answra/shared";
import { useEffect, useState } from "react";
import {
  applyTokens,
  deriveAmbientTokens,
  FALLBACK_TOKEN_KEYS,
  parseHex,
  resolveAmbientScheme,
  type AmbientTokens,
} from "./hooks/useAmbientTheme";
import { COLOR_GROUP_STORAGE_PREFIX } from "./model";

/**
 * 应用主题层：变色龙（ambient）+ 用户颜色分组覆盖，合成单一写入方。
 *
 * 颜色按组管理，与 styles/tokens.css 的「原始参数」分组一一对应；
 * 未来设置页逐组选色时只需写入本模块的覆盖表，无需触碰任何组件样式。
 *
 * 外观方案（data-theme → tokens.css 的深/浅令牌组）没有手动开关：
 *   变色龙开启时由背景亮度决定深/浅；关闭时回落跟随系统。
 * data-theme 与内联令牌都由 useAppTheme 单点写入，不存在双写竞争。
 *
 * 写入优先级（同一原始参数上层的值胜出）：
 *   样式表默认 < ambient 变色龙 < 用户分组覆盖。
 */

export interface ColorGroupDefinition {
  /** 设置页展示名。 */
  label: string;
  /** 该组覆盖的原始参数（-tint 通道）。 */
  tokens: readonly string[];
}

/** 颜色分组注册表：键即设置页的选色项。 */
export const COLOR_GROUPS = {
  text: { label: "文字", tokens: ["--ink-tint"] },
  icon: { label: "图标", tokens: ["--icon-tint"] },
  surface: {
    label: "背景",
    tokens: ["--glass-tint", "--panel-tint", "--paper-tint"],
  },
  accent: {
    label: "强调",
    tokens: ["--mint-tint", "--mint-deep-tint", "--mint-text-tint"],
  },
  line: { label: "描边", tokens: ["--line-tint"] },
  state: { label: "交互态", tokens: ["--hover-tint", "--focus-tint", "--field-tint"] },
  danger: { label: "警示", tokens: ["--danger-tint"] },
} as const satisfies Record<string, ColorGroupDefinition>;

export type ColorGroupId = keyof typeof COLOR_GROUPS;

/** 分组 id → 用户选定的 hex 颜色；未设置的组不出现在表内。 */
export type ColorGroupOverrides = Partial<Record<ColorGroupId, string>>;

/** 把分组覆盖展开为原始参数映射；非法 hex 的组整体忽略。 */
export function colorGroupTokens(overrides: ColorGroupOverrides): AmbientTokens {
  const tokens: AmbientTokens = {};
  for (const [group, hex] of Object.entries(overrides)) {
    if (!hex) continue;
    const channels = hexToChannels(hex);
    if (!channels) continue;
    for (const token of COLOR_GROUPS[group as ColorGroupId].tokens) {
      tokens[token] = channels;
    }
  }
  return tokens;
}

/** hex（#rrggbb）→ 空格分隔 RGB 通道，对应 -tint 原始参数格式。 */
function hexToChannels(hex: string): string | undefined {
  const rgb = parseHex(hex);
  return rgb ? `${rgb.r} ${rgb.g} ${rgb.b}` : undefined;
}

/** 从 localStorage 读取分组覆盖；损坏值直接忽略。 */
export function loadColorGroups(): ColorGroupOverrides {
  const overrides: ColorGroupOverrides = {};
  if (typeof localStorage === "undefined") return overrides;
  for (const group of Object.keys(COLOR_GROUPS)) {
    const hex = localStorage.getItem(COLOR_GROUP_STORAGE_PREFIX + group);
    if (hex && parseHex(hex)) overrides[group as ColorGroupId] = hex;
  }
  return overrides;
}

/** 持久化分组覆盖；空表清除全部已存键。 */
export function saveColorGroups(groups: ColorGroupOverrides): void {
  if (typeof localStorage === "undefined") return;
  for (const group of Object.keys(COLOR_GROUPS)) {
    const key = COLOR_GROUP_STORAGE_PREFIX + group;
    const hex = groups[group as ColorGroupId];
    if (hex && parseHex(hex)) localStorage.setItem(key, hex);
    else localStorage.removeItem(key);
  }
}

/** 解析系统外观偏好；无 matchMedia 环境（jsdom/旧内核）回落浅色。 */
function systemScheme(): "light" | "dark" {
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * 应用主题的唯一入口：data-theme 深浅方案 + 内联原始参数都由此写入。
 * @param bridge 桌面桥（浏览器预览/测试可能没有 onAmbientColor）
 * @param options.ambientFollow 变色龙开关；开启时深浅方案随背景亮度，
 *   关闭或采样失败时回落跟随系统
 * @param options.colorGroups 用户分组覆盖；优先级高于 ambient
 */
export function useAppTheme(
  bridge: DesktopBridge | undefined,
  options: { ambientFollow: boolean; colorGroups: ColorGroupOverrides },
): void {
  const { ambientFollow, colorGroups } = options;
  const [ambient, setAmbient] = useState<AmbientTokens | undefined>(undefined);
  const [ambientScheme, setAmbientScheme] = useState<"light" | "dark" | undefined>(undefined);

  useEffect(() => {
    if (!ambientFollow || !bridge?.onAmbientColor) {
      setAmbient(undefined);
      setAmbientScheme(undefined);
      return;
    }
    return bridge.onAmbientColor((payload) => {
      if (payload.ok) {
        setAmbient(deriveAmbientTokens(payload.hex));
        setAmbientScheme(resolveAmbientScheme(payload.hex));
      } else {
        setAmbient(undefined);
        setAmbientScheme(undefined);
      }
    });
  }, [bridge, ambientFollow]);

  useEffect(() => {
    const merged: AmbientTokens = { ...ambient, ...colorGroupTokens(colorGroups) };
    // 全量回退表写入：ambient 消失的键显式移除，用户覆盖仍然保留
    const full: AmbientTokens = {};
    for (const key of FALLBACK_TOKEN_KEYS) full[key] = merged[key] ?? null;
    applyTokens(full);
  }, [ambient, colorGroups]);

  // data-theme 单一写入方：变色龙深浅判定优先；
  // 变色龙关闭或尚未采样到有效背景时，回落跟随系统
  useEffect(() => {
    const root = document.documentElement;
    if (ambientFollow && ambientScheme) {
      root.dataset.theme = ambientScheme;
      return;
    }
    const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    const apply = () => {
      root.dataset.theme = media?.matches ? "dark" : "light";
    };
    apply();
    media?.addEventListener("change", apply);
    return () => {
      media?.removeEventListener("change", apply);
    };
  }, [ambientFollow, ambientScheme]);
}

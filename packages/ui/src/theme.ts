import type { DesktopBridge } from "@answra/shared";
import { useEffect, useState } from "react";
import {
  applyTokens,
  deriveAmbientTokens,
  FALLBACK_TOKEN_KEYS,
  parseHex,
  type AmbientTokens,
} from "./hooks/useAmbientTheme";
import { COLOR_GROUP_STORAGE_PREFIX } from "./model";

/**
 * 用户颜色分组主题层。
 *
 * 颜色按组管理，与 styles/tokens.css 的「原始参数」分组一一对应；
 * 未来设置页逐组选色时只需写入本模块的覆盖表，无需触碰任何组件样式。
 *
 * 写入优先级（同一原始参数上层的值胜出）：
 *   样式表默认 < ambient 变色龙 < 用户分组覆盖。
 * ambient 与用户覆盖由 useAppTheme 合成后统一写入 :root（单一写入方），
 * 避免两个 effect 各自操作内联样式互相清除。
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
    tokens: ["--glass-tint", "--glass-strong-tint", "--panel-tint", "--paper-tint"],
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

/**
 * 应用主题的唯一入口：ambient 推送 + 用户分组覆盖合成后写入 :root。
 * @param bridge 桌面桥（浏览器预览/测试可能没有 onAmbientColor）
 * @param options.ambientFollow 变色龙开关；关闭或采样失败时该层回落默认
 * @param options.colorGroups 用户分组覆盖；优先级高于 ambient
 */
export function useAppTheme(
  bridge: DesktopBridge | undefined,
  options: { ambientFollow: boolean; colorGroups: ColorGroupOverrides },
): void {
  const { ambientFollow, colorGroups } = options;
  const [ambient, setAmbient] = useState<AmbientTokens | undefined>(undefined);

  useEffect(() => {
    if (!ambientFollow || !bridge?.onAmbientColor) {
      setAmbient(undefined);
      return;
    }
    return bridge.onAmbientColor((payload) => {
      setAmbient(payload.ok ? deriveAmbientTokens(payload.hex) : undefined);
    });
  }, [bridge, ambientFollow]);

  useEffect(() => {
    const merged: AmbientTokens = { ...ambient, ...colorGroupTokens(colorGroups) };
    // 全量回退表写入：ambient 消失的键显式移除，用户覆盖仍然保留
    const full: AmbientTokens = {};
    for (const key of FALLBACK_TOKEN_KEYS) full[key] = merged[key] ?? null;
    applyTokens(full);
  }, [ambient, colorGroups]);
}

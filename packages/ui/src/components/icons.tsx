import type { LucideProps } from "lucide-react";
import { Check, ChevronDown } from "lucide-react";
import { ICON_SM, ICON_STROKE } from "../tokens";

/**
 * 统一的小符号图标：下拉箭头、选中勾等"符号类"图形一律走这里，
 * 与功能图标共用 lucide 体系与描边令牌，禁止在组件里手打
 * ⌄ ✓ 等文本字符（字体渲染不稳定、基线不齐）。
 */

/** 下拉/展开箭头。 */
export function ChevronDownGlyph(props: LucideProps) {
  return <ChevronDown aria-hidden="true" size={ICON_SM} strokeWidth={ICON_STROKE} {...props} />;
}

/** 选中勾。 */
export function CheckGlyph(props: LucideProps) {
  return <Check aria-hidden="true" size={ICON_SM} strokeWidth={ICON_STROKE} {...props} />;
}

export {
  parseSurfaceSpec,
  SURFACE_LIMITS,
  type SurfaceAction,
  type SurfaceButtonNode,
  type SurfaceButtonVariant,
  type SurfaceDividerNode,
  type SurfaceListNode,
  type SurfaceNode,
  type SurfacePanel,
  type SurfaceProgressNode,
  type SurfaceSpec,
  type SurfaceSpecValidation,
  type SurfaceStackNode,
  type SurfaceTextNode,
  type SurfaceTextVariant,
  surfaceSpecSchema,
} from "./spec";

/** 产品内置浮窗预设 id；渲染层与主进程共用同一份常量。 */
export const SurfacePresetIds = {
  InterviewClearConfirm: "interview.clear-confirm",
} as const;

export type SurfacePresetId = (typeof SurfacePresetIds)[keyof typeof SurfacePresetIds];

export const SURFACE_PRESET_IDS: readonly SurfacePresetId[] = Object.values(SurfacePresetIds);

export function isSurfacePresetId(value: unknown): value is SurfacePresetId {
  return typeof value === "string" && SURFACE_PRESET_IDS.some((id) => id === value);
}

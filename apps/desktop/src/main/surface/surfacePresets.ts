import { type SurfacePresetId, SurfacePresetIds, type SurfaceSpec } from "@answra/shared";

const INTERVIEW_CLEAR_CONFIRM: SurfaceSpec = {
  schemaVersion: 1,
  id: SurfacePresetIds.InterviewClearConfirm,
  revision: 0,
  producer: "product",
  presetId: SurfacePresetIds.InterviewClearConfirm,
  title: "清空面试演练？",
  root: {
    type: "stack",
    direction: "column",
    gap: 10,
    children: [
      {
        type: "text",
        variant: "body",
        text: "本次演练的对话记录会被清空，且无法恢复。面试记忆和简历文件不会受影响。",
      },
      {
        type: "stack",
        direction: "row",
        gap: 8,
        children: [
          {
            type: "button",
            label: "取消",
            actionId: "cancel",
            variant: "secondary",
          },
          {
            type: "button",
            label: "清空",
            actionId: "confirm",
            variant: "danger",
          },
        ],
      },
    ],
  },
  window: {
    width: 340,
    draggable: true,
    dismissible: true,
    anchor: "center",
  },
  lifecycle: { kind: "ephemeral" },
  actions: {
    cancel: { type: "dismiss" },
    confirm: { type: "invoke", command: "interview.clear" },
  },
};

const SURFACE_PRESETS: Record<SurfacePresetId, SurfaceSpec> = {
  [SurfacePresetIds.InterviewClearConfirm]: INTERVIEW_CLEAR_CONFIRM,
};

/** 解析产品内置预设；未知 id 返回 undefined，由调用方决定失败提示。 */
export function getSurfacePreset(presetId: string): SurfaceSpec | undefined {
  return (SURFACE_PRESETS as Record<string, SurfaceSpec | undefined>)[presetId];
}

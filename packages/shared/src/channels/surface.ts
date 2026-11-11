/** 浮窗窗口的 IPC 频道与载荷契约。 */

import type { SurfaceAction, SurfacePresetId, SurfaceSpec } from "../surfaces";
import type { ContentSize } from "./window";

export const SurfaceChannels = {
  /** 主窗口渲染器请求显示一个产品内置浮窗。 */
  Show: "answra:surface:show",
  /** 主进程把当前浮窗内容推给浮窗渲染器。 */
  State: "answra:surface:state",
  /** 浮窗渲染器就绪后请求当前内容，避免启动时序丢失首次推送。 */
  Ready: "answra:surface:ready",
  /** 浮窗渲染器请求关闭当前浮窗。 */
  Dismiss: "answra:surface:dismiss",
  /** 浮窗渲染器上报按钮动作 id。 */
  Action: "answra:surface:action",
  /** 主进程把用户动作转发回主窗口渲染器，由产品代码执行。 */
  ActionForwarded: "answra:surface:action-forwarded",
  /** 浮窗渲染器上报自身内容尺寸。 */
  Fit: "answra:surface:fit",
} as const;

/** 浮窗渲染器需要的完整展示状态。 */
export interface SurfaceWindowState {
  spec: SurfaceSpec;
  stealth: boolean;
}

/** 转发给主窗口渲染器的用户动作。 */
export interface SurfaceActionEvent {
  surfaceId: string;
  presetId?: string;
  actionId: string;
  action: SurfaceAction;
}

export interface SurfaceChannelMap {
  [SurfaceChannels.Show]: {
    request: { presetId: SurfacePresetId };
    response: { shown: boolean };
  };
  [SurfaceChannels.State]: { request: undefined; response: undefined };
  [SurfaceChannels.Ready]: { request: undefined; response: undefined };
  [SurfaceChannels.Dismiss]: { request: undefined; response: undefined };
  [SurfaceChannels.Action]: { request: { actionId: string }; response: undefined };
  [SurfaceChannels.ActionForwarded]: { request: SurfaceActionEvent; response: undefined };
  [SurfaceChannels.Fit]: { request: ContentSize; response: undefined };
}

/** 区域截图与选区 overlay 的 IPC 频道和载荷契约。 */
export const CaptureChannels = {
  /**
   * 渲染进程发起区域截图：主进程弹出全屏框选 overlay，用户拖拽选区后
   * 返回该区域的 PNG data URL；取消或失败时返回 ok=false 的结果。
   */
  StartRegionCapture: "answra:capture:start-region",
  /** 框选 overlay 上报选区（逻辑像素，相对所选显示器左上角）。 */
  RegionSelected: "answra:capture:region-selected",
  /** 框选 overlay 取消截图（Esc 或无效拖拽）。 */
  RegionCancelled: "answra:capture:region-cancelled",
} as const;

/** 发起区域截图的选项。 */
export interface RegionCaptureOptions {
  /**
   * 框选虚线颜色：渲染器按当前主题派生的 CSS 颜色（当前墨色），
   * 使框选线随变色龙/深浅模式与用户透明度联动；缺省时 overlay 回落内置灰。
   */
  line?: string;
}

/** 选区矩形（逻辑像素，相对目标显示器左上角）。 */
export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 框选 overlay 上报的选区：所属显示器 + 选区矩形。 */
export interface RegionSelection {
  displayId: number;
  rect: RegionRect;
  /** 最终 mouseup 位置，坐标相对目标显示器左上角，用于回复条定位。 */
  point: { x: number; y: number };
}

/** 区域截图成功结果：PNG data URL 与物理像素尺寸。 */
export interface ScreenshotSuccess {
  ok: true;
  dataUrl: string;
  width: number;
  height: number;
}

/** 区域截图失败结果。 */
export interface ScreenshotFailure {
  ok: false;
  /**
   * cancelled=用户取消；permission=macOS 未授予屏幕录制权限；
   * unavailable=没有可用屏幕画面；error=其他错误（message 含详情）。
   */
  reason: "cancelled" | "error" | "permission" | "unavailable";
  message?: string;
}

export type ScreenshotResult = ScreenshotSuccess | ScreenshotFailure;
/** 截图频道 → 请求/响应载荷 的类型映射。 */
export interface CaptureChannelMap {
  [CaptureChannels.StartRegionCapture]: {
    request: RegionCaptureOptions | undefined;
    response: ScreenshotResult;
  };
  [CaptureChannels.RegionSelected]: { request: RegionSelection; response: undefined };
  [CaptureChannels.RegionCancelled]: { request: undefined; response: undefined };
}

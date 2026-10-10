/**
 * IPC 频道常量。
 *
 * 命名约定：`answra:<域>:<动作>`，与 ZCode 的
 * `<scope>:<kebab-domain>` 频道命名保持一致；所有跨进程通信
 * 必须在此登记，禁止在业务代码里手写字符串频道。
 */
export const WindowChannels = {
  /**
   * 渲染进程上报外壳内容尺寸，主进程据此调整窗口大小。
   * 尺寸决策在渲染器（ResizeObserver 测量胶囊/面板），主进程只做 clamp 与落位。
   */
  FitContent: "answra:window:fit-content",
  /** 关闭应用窗口。 */
  Close: "answra:window:close",
  /** 切换会议隐身：内容保护 + 从任务栏/Dock、Alt+Tab/Cmd+Tab 隐藏。 */
  SetStealth: "answra:window:set-stealth",
  /** 查询当前系统是否可靠支持会议隐身（内容保护）。 */
  GetStealthSupport: "answra:window:get-stealth-support",
} as const;

/** 渲染进程上报的内容尺寸（CSS 像素，含透明呼吸区）。 */
export interface ContentSize {
  width: number;
  height: number;
}

export const AmbientChannels = {
  /**
   * 主进程推送背景主色采样结果（变色龙主题）。
   * 主进程经 desktopCapturer 采样悬浮条周边背景色后主动推送，
   * 渲染器据此重算设计令牌；ok=false 表示采样失败，应回落默认主题。
   */
  AmbientColor: "answra:ambient:color",
} as const;

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

/** 背景主色采样结果（主进程 → 渲染进程推送）。 */
export interface AmbientColorPayload {
  /** 采样是否成功；失败时 hex/luminance 无效。 */
  ok: boolean;
  /** 背景主色，#rrggbb。 */
  hex: string;
  /** 背景相对亮度（0~1，sRGB 加权）。 */
  luminance: number;
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

/**
 * 频道 → 请求/响应载荷 的类型映射。
 * preload 与 main 的 handler 均以此为准，实现三层类型安全。
 */
export interface WindowChannelMap {
  [WindowChannels.FitContent]: { request: ContentSize; response: undefined };
  [WindowChannels.Close]: { request: undefined; response: undefined };
  [WindowChannels.SetStealth]: { request: boolean; response: undefined };
  [WindowChannels.GetStealthSupport]: { request: undefined; response: boolean };
}

/** 截图频道 → 请求/响应载荷 的类型映射。 */
export interface CaptureChannelMap {
  [CaptureChannels.StartRegionCapture]: { request: undefined; response: ScreenshotResult };
  [CaptureChannels.RegionSelected]: { request: RegionSelection; response: undefined };
  [CaptureChannels.RegionCancelled]: { request: undefined; response: undefined };
}

/** 按频道名取出请求/响应类型的工具类型。 */
export type ChannelRequest<C extends keyof WindowChannelMap> = WindowChannelMap[C]["request"];
export type ChannelResponse<C extends keyof WindowChannelMap> = WindowChannelMap[C]["response"];

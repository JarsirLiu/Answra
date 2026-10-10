/**
 * IPC 频道常量。
 *
 * 命名约定：`exam-assistant:<域>:<动作>`，与 ZCode 的
 * `<scope>:<kebab-domain>` 频道命名保持一致；所有跨进程通信
 * 必须在此登记，禁止在业务代码里手写字符串频道。
 */
export const WindowChannels = {
  /**
   * 渲染进程上报外壳内容尺寸，主进程据此调整窗口大小。
   * 尺寸决策在渲染器（ResizeObserver 测量胶囊/面板），主进程只做 clamp 与落位。
   */
  FitContent: "exam-assistant:window:fit-content",
  /** 关闭应用窗口。 */
  Close: "exam-assistant:window:close",
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
  AmbientColor: "exam-assistant:ambient:color",
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

/**
 * 频道 → 请求/响应载荷 的类型映射。
 * preload 与 main 的 handler 均以此为准，实现三层类型安全。
 */
export interface WindowChannelMap {
  [WindowChannels.FitContent]: { request: ContentSize; response: void };
  [WindowChannels.Close]: { request: void; response: void };
}

/** 按频道名取出请求/响应类型的工具类型。 */
export type ChannelRequest<C extends keyof WindowChannelMap> = WindowChannelMap[C]["request"];
export type ChannelResponse<C extends keyof WindowChannelMap> = WindowChannelMap[C]["response"];

/** 背景采样与变色龙设置的 IPC 频道和载荷契约。 */
export const AmbientChannels = {
  /** renderer 按用户变色龙设置启停主进程的屏幕采样。 */
  SetFollow: "answra:ambient:set-follow",
  /**
   * 主进程推送背景主色采样结果（变色龙路径）。
   * 主进程经 desktopCapturer 整屏采样悬浮条周边背景色后主动推送，
   * 渲染器据此重算设计令牌；ok=false 表示采样失败，应回落默认主题。
   */
  AmbientColor: "answra:ambient:color",
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

/** 变色龙频道 → 请求/响应载荷 的类型映射。 */
export interface AmbientChannelMap {
  [AmbientChannels.SetFollow]: { request: boolean; response: undefined };
  [AmbientChannels.AmbientColor]: { request: undefined; response: undefined };
}

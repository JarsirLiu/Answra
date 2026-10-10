import type { AmbientColorPayload, ContentSize } from "./channels";

/**
 * 悬浮条窗口的内容面板标识。
 *
 * `closed` 表示只显示悬浮导航条；其余值为打开的内容面板。
 * 面板只决定渲染器画什么，窗口大小由渲染器测量后经
 * `fitContent` 上报（见 channels.ts 的 FitContent 频道）。
 */
export type OverlayMode = "closed" | "chat" | "notes" | "sources" | "settings";

/** 渲染进程暴露给 UI 的桌面平台桥（由 preload 注入，测试可 mock）。 */
export interface DesktopBridge {
  /** 上报外壳内容尺寸，主进程据此调整窗口大小。 */
  fitContent: (size: ContentSize) => void;
  /** 关闭应用窗口。 */
  close: () => void;
  /**
   * 切换窗口内容保护（会议隐身）。开启后，屏幕共享与截图工具捕获到的是
   * 空白而非本应用内容，用户自身屏幕上仍正常可见。浏览器预览/测试环境可未实现。
   */
  setContentProtection?: (value: boolean) => void;
  /**
   * 订阅背景主色推送（变色龙主题）；返回取消订阅函数。
   * 浏览器预览/测试环境可未实现，调用方需判空。
   */
  onAmbientColor?: (listener: (payload: AmbientColorPayload) => void) => () => void;
}

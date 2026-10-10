/**
 * 悬浮条窗口的展示模式。
 *
 * `closed` 表示只显示悬浮导航条；其余值为打开的内容面板，
 * 与窗口高度联动（见 apps/desktop 主进程 windowHeights）。
 */
export type OverlayMode = "closed" | "chat" | "notes" | "sources" | "settings";

/** 渲染进程暴露给 UI 的桌面平台桥（由 preload 注入，测试可 mock）。 */
export interface DesktopBridge {
  /** 切换窗口模式（收起 / 打开某个面板）。 */
  setMode: (mode: OverlayMode) => void;
  /** 关闭应用窗口。 */
  close: () => void;
}

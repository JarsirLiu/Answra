import type {
  AmbientColorPayload,
  ContentSize,
  ConversationEvent,
  ConversationModelConfig,
  ConversationSendRequest,
  RegionCaptureOptions,
  ReplyBarAction,
  ReplyBarState,
  ScreenshotResult,
} from "./channels";

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
  /** Syncs task state to the separately protected reply window. */
  setReplyBarState?: (state: ReplyBarState | null) => void;
  /** Measures the detached reply window without resizing the toolbar HWND. */
  fitReplyBar?: (size: ContentSize) => void;
  /** Routes reply window controls back to the state owning renderer. */
  sendReplyBarAction?: (action: ReplyBarAction) => void;
  onReplyBarAction?: (listener: (action: ReplyBarAction) => void) => () => void;
  onReplyBarState?: (listener: (state: ReplyBarState) => void) => () => void;
  /** Requests the latest workflow snapshot after the reply renderer subscribes. */
  requestReplyBarState?: () => void;
  /**
   * 切换会议隐身。开启后，系统支持的捕获路径会排除本应用窗口，
   * 且应用从任务栏/Dock 与 Alt+Tab/Cmd+Tab 中隐藏；用户自身屏幕上仍正常可见。
   * 实际捕获行为由操作系统和捕获应用决定，不能覆盖忽略窗口排除标志的捕获路径。
   * 浏览器预览/测试环境可未实现。
   */
  setStealth?: (value: boolean) => void;
  /**
   * 查询当前系统是否可靠支持会议隐身（内容保护）。
   * 旧 Windows（build < 19041）与 Linux 会返回 false。
   * 浏览器预览/测试环境可未实现，调用方需判空。
   */
  getStealthSupport?: () => Promise<boolean>;
  /**
   * 发起区域截图：主进程弹出全屏框选 overlay，用户拖拽选区后返回该区域的
   * PNG data URL；用户取消或截图失败时返回 ok=false（含原因）。
   * 浏览器预览/测试环境可未实现，调用方需判空。
   */
  startRegionCapture?: (options?: RegionCaptureOptions) => Promise<ScreenshotResult>;
  /**
   * 订阅背景主色推送（变色龙）；返回取消订阅函数。
   * 浏览器预览/测试环境可未实现，调用方需判空。
   */
  onAmbientColor?: (listener: (payload: AmbientColorPayload) => void) => () => void;
  /** 按用户设置启停主进程变色龙屏幕采样。 */
  setAmbientFollow?: (value: boolean) => void;
  configureConversation?: (config: ConversationModelConfig) => Promise<void>;
  getConversationConfig?: () => Promise<
    Omit<ConversationModelConfig, "apiKey"> & { configured: boolean }
  >;
  /**
   * 按需拉取已解密的 API Key（用户点显隐图标时回显）。
   * 未保存 Key 时返回 null；不随配置查询自动下发，浏览器预览/测试环境可未实现。
   */
  getConversationApiKey?: () => Promise<{ apiKey: string | null }>;
  sendConversationMessage?: (request: ConversationSendRequest) => Promise<{ runId: string }>;
  cancelConversationRun?: (runId: string) => void;
  onConversationEvent?: (listener: (event: ConversationEvent) => void) => () => void;
}

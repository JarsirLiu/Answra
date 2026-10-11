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
  /** 切换会议隐身：排除系统支持的捕获路径，并从任务栏/Dock、Alt+Tab/Cmd+Tab 隐藏。 */
  SetStealth: "answra:window:set-stealth",
  /** 查询当前系统是否可靠支持会议隐身（内容保护）。 */
  GetStealthSupport: "answra:window:get-stealth-support",
  /** 主窗口同步任务工作流到独立回复窗口；null 表示结束工作流。 */
  SetReplyBarState: "answra:window:set-reply-bar-state",
  /** 独立回复窗口上报自身尺寸，不调整主工具栏窗口。 */
  FitReplyBar: "answra:window:fit-reply-bar",
  /** 回复窗口发起的用户操作。 */
  ReplyBarAction: "answra:window:reply-bar-action",
  /** 主进程把最新任务状态推送给回复窗口。 */
  ReplyBarState: "answra:window:reply-bar-state",
  /** 回复窗口订阅就绪后请求当前状态，避免启动时序丢失首次推送。 */
  ReplyBarReady: "answra:window:reply-bar-ready",
} as const;

/** 渲染进程上报的内容尺寸（CSS 像素，含透明呼吸区）。 */
export interface ContentSize {
  width: number;
  height: number;
}

export interface ReplyBarAttachment {
  id: string;
  name: string;
  previewUrl: string;
}

export interface ReplyBarState {
  phase: "composing" | "streaming";
  attachments: ReplyBarAttachment[];
  draft: string;
  replyText: string;
  stealth: boolean;
  theme: { scheme?: string; variables: Record<string, string> };
}

export type ReplyBarAction =
  | { type: "draft/change"; value: string }
  | { type: "attachment/add"; attachment: ReplyBarAttachment }
  | { type: "attachment/remove"; id: string }
  | { type: "screenshot/start" }
  | { type: "send" }
  | { type: "cancel" }
  | { type: "close" };

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

export const ConversationChannels = {
  Configure: "answra:conversation:configure",
  GetConfig: "answra:conversation:get-config",
  Send: "answra:conversation:send",
  Cancel: "answra:conversation:cancel",
  Event: "answra:conversation:event",
} as const;

export interface ConversationModelConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface ConversationSendRequest {
  text: string;
  images: Array<{ name: string; dataUrl: string }>;
}

export type ConversationEvent =
  | { type: "run/started"; runId: string; conversationId: string }
  | { type: "text/delta"; runId: string; delta: string }
  | { type: "run/completed"; runId: string }
  | { type: "run/failed"; runId: string; message: string }
  | { type: "run/cancelled"; runId: string };

export interface ConversationChannelMap {
  [ConversationChannels.Configure]: { request: ConversationModelConfig; response: undefined };
  [ConversationChannels.GetConfig]: {
    request: undefined;
    response: Omit<ConversationModelConfig, "apiKey"> & { configured: boolean };
  };
  [ConversationChannels.Send]: { request: ConversationSendRequest; response: { runId: string } };
  [ConversationChannels.Cancel]: { request: { runId: string }; response: undefined };
  [ConversationChannels.Event]: { request: undefined; response: undefined };
}

/** 发起区域截图的选项。 */
export interface RegionCaptureOptions {
  /**
   * 框选虚线颜色：渲染器按当前主题派生的 CSS 颜色（当前墨色），
   * 使框选线随变色龙/深浅模式与用户透明度联动；缺省时 overlay 回落内置灰。
   */
  line?: string;
}

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
  [WindowChannels.SetReplyBarState]: { request: ReplyBarState | null; response: undefined };
  [WindowChannels.FitReplyBar]: { request: ContentSize; response: undefined };
  [WindowChannels.ReplyBarAction]: { request: ReplyBarAction; response: undefined };
  [WindowChannels.ReplyBarState]: { request: undefined; response: undefined };
  [WindowChannels.ReplyBarReady]: { request: undefined; response: undefined };
}

/** 截图频道 → 请求/响应载荷 的类型映射。 */
export interface CaptureChannelMap {
  [CaptureChannels.StartRegionCapture]: {
    request: RegionCaptureOptions | undefined;
    response: ScreenshotResult;
  };
  [CaptureChannels.RegionSelected]: { request: RegionSelection; response: undefined };
  [CaptureChannels.RegionCancelled]: { request: undefined; response: undefined };
}

/** 变色龙频道 → 请求/响应载荷 的类型映射。 */
export interface AmbientChannelMap {
  [AmbientChannels.SetFollow]: { request: boolean; response: undefined };
  [AmbientChannels.AmbientColor]: { request: undefined; response: undefined };
}

/** 按频道名取出请求/响应类型的工具类型。 */
export type ChannelRequest<C extends keyof WindowChannelMap> = WindowChannelMap[C]["request"];
export type ChannelResponse<C extends keyof WindowChannelMap> = WindowChannelMap[C]["response"];

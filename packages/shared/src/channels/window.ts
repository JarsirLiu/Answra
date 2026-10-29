/** 主窗口与独立回复窗口的 IPC 频道和载荷契约。 */
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
  /** 回复窗口上报展开面板的位置方向。 */
  ReplyBarPlacement: "answra:window:reply-bar-placement",
  /** 回复窗口发起的用户操作。 */
  ReplyBarAction: "answra:window:reply-bar-action",
  /** 主进程把最新任务状态推送给回复窗口。 */
  ReplyBarState: "answra:window:reply-bar-state",
  /** 回复窗口订阅就绪后请求当前状态，避免启动时序丢失首次推送。 */
  ReplyBarReady: "answra:window:reply-bar-ready",
} as const;

export type ReplyBarPlacement = "above" | "below";

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

export interface ReplyBarActivity {
  id: string;
  kind: "thinking" | "text" | "tool" | "status" | "source" | "error";
  label: string;
  text: string;
}

export interface ReplyBarState {
  phase: "composing" | "streaming" | "done";
  /** One-send screenshot transcript; absent until a screenshot is submitted. */
  conversationId?: string;
  attachments: ReplyBarAttachment[];
  draft: string;
  replyText: string;
  replyActivities: ReplyBarActivity[];
  replyError?: string;
  replyPending?: boolean;
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

/** 按窗口频道名取出请求/响应类型的工具类型。 */
export type ChannelRequest<C extends keyof WindowChannelMap> = WindowChannelMap[C]["request"];
export type ChannelResponse<C extends keyof WindowChannelMap> = WindowChannelMap[C]["response"];

import type { UIMessageChunk } from "ai";

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
  phase: "composing" | "streaming";
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
  /** 按需拉取已解密 API Key（用户点显隐时回显）；无 Key 返回 null。 */
  GetApiKey: "answra:conversation:get-api-key",
  Send: "answra:conversation:send",
  Cancel: "answra:conversation:cancel",
  GetSnapshot: "answra:conversation:get-snapshot",
  Create: "answra:conversation:create",
  ReadEvents: "answra:conversation:read-events",
  Change: "answra:conversation:change",
} as const;

export const InterviewChannels = {
  Start: "answra:interview:start",
  Stop: "answra:interview:stop",
  AudioFrame: "answra:interview:audio-frame",
  Change: "answra:interview:change",
} as const;

export type InterviewSpeaker = "interviewer" | "user";
export type InterviewState = "connecting" | "listening" | "thinking" | "stopped" | "error";

export type InterviewChange =
  | { sessionId: string; type: "state"; state: InterviewState; message?: string }
  | {
      sessionId: string;
      type: "transcript";
      speaker: InterviewSpeaker;
      text: string;
      final: boolean;
      timestamp: number;
    }
  | { sessionId: string; type: "answer-start"; questionId: string; question: string }
  | { sessionId: string; type: "answer"; questionId: string; text: string }
  | { sessionId: string; type: "answer-ignored"; questionId: string }
  | { sessionId: string; type: "answer-stale"; questionId: string };

export interface InterviewAudioFrame {
  sessionId: string;
  speaker: InterviewSpeaker;
  pcm16Base64: string;
}

export const ActiveExamConversationId = "active-exam-conversation";

export interface ConversationModelConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface ConversationSendRequest {
  text: string;
  images: Array<{ name: string; dataUrl: string }>;
}

export interface ConversationSendCommand {
  conversationId: string;
  request: ConversationSendRequest;
}

export type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  images: Array<{ name: string; dataUrl: string }>;
  status: "complete" | "streaming" | "interrupted";
};

export type ConversationSnapshot = {
  conversationId: string;
  revision: number;
  messages: ConversationMessage[];
  activeRunId?: string;
};

export type ConversationEvent = {
  conversationId: string;
  runId: string;
  revision: number;
  chunk: UIMessageChunk;
};

export type ConversationChange =
  | { type: "snapshot"; snapshot: ConversationSnapshot }
  | {
      type: "messages-appended";
      conversationId: string;
      revision: number;
      messages: ConversationMessage[];
      activeRunId: string;
    }
  | { type: "event"; event: ConversationEvent }
  | {
      type: "run-finished";
      conversationId: string;
      revision: number;
      runId: string;
      message: ConversationMessage;
    };

/**
 * 本地工作区（合并笔记本与资料）频道。
 *
 * 所有路径参数均为相对根目录的 POSIX 风格路径（"/" 分隔）；
 * main 侧负责把相对路径解析为绝对路径并做根目录边界校验。
 */
export const WorkspaceChannels = {
  /** 读取缓存的上一工作区根目录（不存在或已失效时 root 为 null）。 */
  GetRoot: "answra:workspace:get-root",
  /** 弹出系统目录选择框；用户取消时 root 为 null。选择成功即缓存为新根目录。 */
  PickRoot: "answra:workspace:pick-root",
  /** 列出根目录下的完整目录树（目录在前、名称排序）。 */
  ListTree: "answra:workspace:list-tree",
  /** 读取文件：返回 base64 字节与 UTF-8 文本（二进制文件 text 为 null）。 */
  ReadFile: "answra:workspace:read-file",
  /** 以 UTF-8 写入文本文件（仅 md 等文本类型）。 */
  WriteFile: "answra:workspace:write-file",
  /** 写入二进制文件（仅图片类型，base64；用于粘贴截图落盘）。 */
  WriteBytes: "answra:workspace:write-bytes",
  /** 新建目录或空 md 文档（父目录自动创建；已存在时失败）。 */
  CreateEntry: "answra:workspace:create-entry",
  /** 删除文件或目录（目录递归删除）。 */
  DeleteEntry: "answra:workspace:delete-entry",
  /** 主进程 → 渲染进程推送根目录内变更（watcher 防抖合并后的相对路径列表）。 */
  Changed: "answra:workspace:changed",
} as const;

/** 应用内输入法频道；引擎状态由 main 持有，候选 UI 由 renderer 绘制。 */
export const ImeChannels = {
  Enable: "answra:ime:enable",
  Key: "answra:ime:key",
  Select: "answra:ime:select",
  Reset: "answra:ime:reset",
  Change: "answra:ime:change",
} as const;

/** 候选条独立窗口协议：输入窗口推送状态，候选窗口只回传用户操作。 */
export const ImeCandidateChannels = {
  Update: "answra:ime-candidate:update",
  State: "answra:ime-candidate:state",
  Ready: "answra:ime-candidate:ready",
  Fit: "answra:ime-candidate:fit",
  Action: "answra:ime-candidate:action",
  OwnerAction: "answra:ime-candidate:owner-action",
} as const;

export interface ImeCandidateAnchor {
  /** Start of the active preedit in the input renderer viewport, in CSS pixels. */
  x: number;
  lineTop: number;
  lineBottom: number;
}

export type ImeCandidateUpdate =
  | { type: "show"; state: ImeState; anchor: ImeCandidateAnchor }
  | { type: "suspend" }
  | { type: "clear"; state?: ImeState };

export type ImeCandidateAction =
  | { type: "select"; index: number }
  | { type: "navigate"; key: "PageUp" | "PageDown" };

export interface ImeCandidateChannelMap {
  [ImeCandidateChannels.Update]: {
    request: ImeCandidateUpdate;
    response: undefined;
  };
  [ImeCandidateChannels.State]: { request: undefined; response: ImeState };
  [ImeCandidateChannels.Ready]: { request: undefined; response: undefined };
  [ImeCandidateChannels.Fit]: { request: ContentSize; response: undefined };
  [ImeCandidateChannels.Action]: { request: ImeCandidateAction; response: undefined };
  [ImeCandidateChannels.OwnerAction]: { request: undefined; response: undefined };
}

export interface ImeCandidate {
  text: string;
  comment?: string;
}

export interface ImeState {
  enabled: boolean;
  composing: boolean;
  preedit: string;
  candidates: ImeCandidate[];
  selectedIndex: number;
  page: number;
  hasNextPage: boolean;
  committedText?: string;
  /** Whether the native engine consumed the last key event. */
  handled?: boolean;
}

export interface ImeKeyRequest {
  key: string;
  code: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

export interface ImeChannelMap {
  [ImeChannels.Enable]: { request: boolean; response: ImeState };
  [ImeChannels.Key]: { request: ImeKeyRequest; response: ImeState };
  [ImeChannels.Select]: { request: { index: number }; response: ImeState };
  [ImeChannels.Reset]: { request: undefined; response: ImeState };
  [ImeChannels.Change]: { request: undefined; response: ImeState };
}

/** 工作区目录树节点；`path` 为相对根目录的 POSIX 风格路径，根目录本身不出现。 */
export interface WorkspaceNode {
  name: string;
  path: string;
  kind: "dir" | "file";
}

/** 工作区文件读取结果。 */
export interface WorkspaceFileContent {
  /** 媒体类型推断（png/jpeg/webp/gif/pdf/docx…，未知为 application/octet-stream）。 */
  mediaType: string;
  /** 原始字节（base64）。 */
  dataBase64: string;
  /** UTF-8 文本内容；二进制文件为 null。 */
  text: string | null;
}

export interface WorkspaceCreateRequest {
  path: string;
  kind: "dir" | "file";
}

/** 主进程推送的根目录内变更（相对路径，POSIX 分隔）。 */
export interface WorkspaceChangeSet {
  paths: string[];
}

export interface WorkspaceChannelMap {
  [WorkspaceChannels.GetRoot]: { request: undefined; response: { root: string | null } };
  [WorkspaceChannels.PickRoot]: { request: undefined; response: { root: string | null } };
  [WorkspaceChannels.ListTree]: { request: undefined; response: WorkspaceNode[] };
  [WorkspaceChannels.ReadFile]: {
    request: { path: string };
    response: WorkspaceFileContent;
  };
  [WorkspaceChannels.WriteFile]: { request: { path: string; text: string }; response: undefined };
  [WorkspaceChannels.WriteBytes]: {
    request: { path: string; dataBase64: string };
    response: undefined;
  };
  [WorkspaceChannels.CreateEntry]: {
    request: WorkspaceCreateRequest;
    response: undefined;
  };
  [WorkspaceChannels.DeleteEntry]: { request: { path: string }; response: undefined };
  [WorkspaceChannels.Changed]: { request: undefined; response: undefined };
}

export interface ConversationChannelMap {
  [ConversationChannels.Configure]: { request: ConversationModelConfig; response: undefined };
  [ConversationChannels.GetConfig]: {
    request: undefined;
    response: Omit<ConversationModelConfig, "apiKey"> & { configured: boolean };
  };
  [ConversationChannels.GetApiKey]: { request: undefined; response: { apiKey: string | null } };
  [ConversationChannels.Send]: {
    request: ConversationSendCommand;
    response: { runId: string };
  };
  [ConversationChannels.Cancel]: { request: { runId: string }; response: undefined };
  [ConversationChannels.GetSnapshot]: {
    request: { conversationId: string };
    response: ConversationSnapshot;
  };
  [ConversationChannels.Create]: {
    request: { conversationId: string };
    response: ConversationSnapshot;
  };
  [ConversationChannels.ReadEvents]: {
    request: { conversationId: string; afterRevision: number };
    response: ConversationChange[];
  };
  [ConversationChannels.Change]: { request: undefined; response: undefined };
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

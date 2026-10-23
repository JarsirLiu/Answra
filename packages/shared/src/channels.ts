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
  Send: "answra:conversation:send",
  AppendUserMessage: "answra:conversation:append-user-message",
  Cancel: "answra:conversation:cancel",
  GetSnapshot: "answra:conversation:get-snapshot",
  Create: "answra:conversation:create",
  ReadEvents: "answra:conversation:read-events",
  /** 读取模型来源与本地端点摘要（不含 API Key）。 */
  GetConfig: "answra:conversation:get-config",
  /** 切换模型来源并保存本地端点；Key 留空表示沿用已保存的值。 */
  Configure: "answra:conversation:configure",
  /** 仅在用户点开明文时读取本机保存的 API Key。 */
  GetApiKey: "answra:conversation:get-api-key",
  /** 清除本地端点与 Key，恢复云端订阅。 */
  ClearConfig: "answra:conversation:clear-config",
  Change: "answra:conversation:change",
} as const;

/**
 * 「调用模型需要登录」的统一失败码。
 *
 * 两条来源都用同一个码：main 调用边界的前置门禁（未登录直接拒绝），以及云端返回 401
 * （网关 `error.code=unauthorized`，由 agent 的 fetch 包装器转成这个码）。渲染层只按码
 * 决定是否提示登录，不解析错误文案：同一类失败必须只有一个判定来源。
 */
export const AUTH_REQUIRED_CODE = "auth-required";

/** 未登录调用模型时的用户可见文案；对话与截图答题共用同一句（同一失败同一提示）。 */
export const AUTH_REQUIRED_NOTICE = "请先登录后再使用（设置 → 账户）";

/**
 * 识别任意层抛上来的错误（含 Electron IPC 重新包装后的 Error）是否表示「需要登录」。
 * 也接受裸字符串：流式 error chunk 与状态里保存的都是错误文案本身。
 */
export function isAuthRequiredError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  return message.includes(AUTH_REQUIRED_CODE);
}

/** 构造带失败码的「需要登录」错误，供 main 侧门禁抛出。 */
export function authRequiredError(): Error {
  return new Error(`${AUTH_REQUIRED_CODE}: ${AUTH_REQUIRED_NOTICE}`);
}

/**
 * 云端账号频道（登录解锁会员）。
 *
 * main 持有全部 token 与刷新逻辑；渲染层只能拿到不含 token 的 `AuthStatus`。
 */
export const AuthChannels = {
  /** 在系统浏览器打开站点授权页完成登录；回跳由深链/环回回调驱动，本调用不等待结果。 */
  Login: "answra:auth:login",
  /** 退出登录：尽最大努力撤销本机 refresh token 并清除本地凭据。 */
  Logout: "answra:auth:logout",
  /** 查询当前账号与会员状态（不含任何 token）。 */
  GetStatus: "answra:auth:get-status",
  /** 主进程推送账号状态变化（登录成功、登出、凭据失效）。 */
  Status: "answra:auth:status",
  /** 读取当前账号可见的站点公告；token 只由 main 使用。 */
  ListAnnouncements: "answra:auth:list-announcements",
  /** 将当前账号可见公告标记为已读。 */
  MarkAnnouncementRead: "answra:auth:mark-announcement-read",
} as const;

export interface DesktopAnnouncement {
  id: number;
  title: string;
  content: string;
  notifyMode: "silent" | "popup";
  readAt: string | null;
  createdAt: string;
}

/**
 * 已登录账号的展示信息（不含 token）。
 * 字段均为服务端原样下发的可空值：站点允许用用户名或邮箱登录，缺哪个就为 null。
 */
export interface AuthAccountInfo {
  email: string | null;
  username: string | null;
}

/**
 * 套餐额度快照（来自站点 `GET /api/v1/subscriptions/progress`）。
 * 只表达用户可见的用量进度，不含金额或服务端内部配额。
 */
export interface AuthQuotaInfo {
  /** Active subscription plan name, if one exists. */
  planName?: string | null;
  /** 当前计费周期已用额度百分比（0-100）；服务端未提供为 null。 */
  usedPercent: number | null;
  /** 套餐到期时间（RFC3339）；无到期时间或无有效套餐为 null。 */
  expiresAt: string | null;
  /** 套餐剩余天数；无有效套餐为 null。 */
  daysRemaining: number | null;
}

/**
 * 账号与会员状态快照。
 *
 * 故意不含 token：渲染层（以及未来可能的调试面板）只需要门禁与展示所需的事实。
 */
export interface AuthStatus {
  signedIn: boolean;
  /** 会员档位标识，由服务端下发；未登录为 null。 */
  plan: string | null;
  /** 账号展示信息；未登录、旧版本或拉取失败时为 null。 */
  account?: AuthAccountInfo | null;
  /** 套餐额度快照；无有效套餐或未登录时为 null。 */
  quota?: AuthQuotaInfo | null;
  /** 当前账号可用的能力 ID 列表（如 `text.chat`）；未登录为空数组。 */
  capabilities: string[];
  /** 云端模式要使用的网关地址（本地只保存地址，不含模型配置）；未登录为 null。 */
  cloudBaseUrl: string | null;
}

/** 登录启动结果：只表示浏览器是否被拉起，登录结果经 `AuthChannels.Status` 推送。 */
export interface AuthLoginResult {
  opened: boolean;
  error?: string;
}

export interface AuthChannelMap {
  [AuthChannels.Login]: { request: undefined; response: AuthLoginResult };
  [AuthChannels.Logout]: { request: undefined; response: AuthStatus };
  [AuthChannels.GetStatus]: { request: undefined; response: AuthStatus };
  [AuthChannels.Status]: { request: undefined; response: undefined };
  [AuthChannels.ListAnnouncements]: { request: undefined; response: DesktopAnnouncement[] };
  [AuthChannels.MarkAnnouncementRead]: { request: number; response: undefined };
}

export const InterviewChannels = {
  Start: "answra:interview:start",
  Stop: "answra:interview:stop",
  CaptureReady: "answra:interview:capture-ready",
  CaptureFailed: "answra:interview:capture-failed",
  AudioFrame: "answra:interview:audio-frame",
  AudioCredit: "answra:interview:audio-credit",
  Change: "answra:interview:change",
} as const;

/** Bounds audio frames in flight while the Agent processes them in batches. */
export const INTERVIEW_AUDIO_CREDIT_WINDOW = 10;
export const INTERVIEW_AUDIO_CREDIT_BATCH = 5;

export type InterviewSpeaker = "interviewer" | "user";
export type InterviewAudioSource = "interviewer" | "candidate";
export type InterviewState = "connecting" | "listening" | "thinking" | "stopped" | "error";

export type InterviewChange =
  | { sessionId: string; type: "state"; state: InterviewState; message?: string }
  | {
      sessionId: string;
      type: "transcript";
      speaker: InterviewSpeaker;
      utteranceId: string;
      chunkIndex: number;
      text: string;
      final: boolean;
      turnEnd: boolean;
      timestamp: number;
    }
  | { sessionId: string; type: "answer-start"; questionId: string; question: string }
  | { sessionId: string; type: "answer"; questionId: string; text: string }
  | { sessionId: string; type: "answer-ignored"; questionId: string }
  | { sessionId: string; type: "answer-stale"; questionId: string };

/** Binary PCM IPC DTO. Provider and Agent domain types do not cross into shared. */
export interface InterviewPcmFrame {
  sessionId: string;
  source: InterviewAudioSource;
  sequence: number;
  startSample: number;
  sampleRate: 16_000;
  channels: 1;
  encoding: "pcm_s16le";
  pcm: Uint8Array;
}

export interface InterviewChannelMap {
  [InterviewChannels.Start]: {
    request: { conversationId: string };
    response: { sessionId: string };
  };
  [InterviewChannels.Stop]: { request: { sessionId: string }; response: undefined };
  [InterviewChannels.CaptureReady]: { request: { sessionId: string }; response: undefined };
  [InterviewChannels.CaptureFailed]: { request: { sessionId: string }; response: undefined };
  [InterviewChannels.AudioFrame]: { request: InterviewPcmFrame; response: undefined };
  [InterviewChannels.AudioCredit]: {
    request: { sessionId: string; count: number };
    response: undefined;
  };
  [InterviewChannels.Change]: { request: undefined; response: undefined };
}

export const ActiveExamConversationId = "active-exam-conversation";
export const ActiveChatConversationId = "active-chat-conversation";
export const ActiveInterviewConversationId = "active-interview-conversation";

/**
 * 云端能力 ID（跨仓库契约，与网关 `internal/domain/desktop_capability.go` 同值）。
 *
 * 客户端把能力 ID 作为占位 `model` 下发，网关再改写为自己的稳定上游别名：
 * 因此模型改名、换供应商都不需要发布客户端，客户端也永远不感知真实模型名。
 */
export const DesktopCapability = {
  /** 对话补全。 */
  TextChat: "text.chat",
  /** 截图答题。 */
  ImageAnswer: "image.answer",
} as const;

/**
 * 一项云端能力的调用信息，全部由服务端下发（`GET /api/v1/capabilities` 的 `endpoints[]`）：
 * `baseUrl` 由云端 origin 与服务端声明的 path 拼出，`model` 是服务端声明的占位模型。
 * 客户端不硬编码路径与模型名，只按能力 ID 取用。
 */
export interface ConversationCapabilityEndpoint {
  baseUrl: string;
  model: string;
  /**
   * 凭据来源：`cloud` 使用账号令牌并在 401 时刷新重试；`local` 使用本机保存的
   * API Key，不触发登录、不刷新令牌。缺省按 `cloud` 处理。
   */
  auth?: "cloud" | "local";
}

/**
 * agent 运行时的模型配置：两项云端能力各自的端点。
 *
 * 不再包含任何用户凭据——访问令牌按次运行注入（见 `AgentCommand` 的 `accessToken`），
 * 不落盘、不进 renderer，也不作为配置的一部分被保存。
 */
export interface ConversationModelConfig {
  /** 对话能力（`DesktopCapability.TextChat`）。 */
  chat: ConversationCapabilityEndpoint;
  /** 截图答题能力（`DesktopCapability.ImageAnswer`）。 */
  answer: ConversationCapabilityEndpoint;
}

/**
 * 模型调用来源：`local` 走本机保存的自定义端点（OpenAI 兼容），`cloud` 走云端订阅。
 *
 * 这是显式切换，不是优先级兜底：选哪一路就只用哪一路。本地来源仅在开发态可选，
 * 打包版固定云端，避免绕过订阅。
 */
export type ConversationModelSource = "local" | "cloud";

/** 保存给主进程的模型设置；`apiKey` 留空表示沿用已保存的 Key。 */
export interface ConversationModelSettings {
  source: ConversationModelSource;
  /** OpenAI 兼容地址，如 `http://127.0.0.1:1234/v1`。 */
  baseUrl: string;
  /** 对话模型 ID。 */
  model: string;
  /** 截图答题模型 ID；留空沿用 `model`。 */
  answerModel?: string;
  /** 本地端点的 API Key；留空表示沿用已保存的值。 */
  apiKey?: string;
}

/** 渲染层可见的模型设置摘要（不含任何凭据）。 */
export interface ConversationModelSettingsView {
  source: ConversationModelSource;
  /** 是否允许选择本地来源（仅开发态为 true）。 */
  localAvailable: boolean;
  baseUrl: string;
  model: string;
  answerModel: string;
  /** 本地端点是否已配置可用。 */
  configured: boolean;
}

export interface ConversationSendRequest {
  text: string;
  images: Array<{ name: string; dataUrl: string }>;
}

export interface ChatSendCommand {
  operation: "chat.send";
  conversationId: string;
  profileId: "general-chat";
  request: ConversationSendRequest;
}

export interface AnswerRunCommand {
  operation: "answer.run";
  conversationId: string;
  request: ConversationSendRequest;
}

export type ConversationSendCommand = ChatSendCommand | AnswerRunCommand;

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
      activeRunId?: string;
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

/**
 * 应用内输入法频道；引擎状态由 main 持有，候选 UI 由 renderer 绘制。
 *
 * 唯一的会话入口是 `SessionCommand`：所有租约/按键/候选操作都以类型化命令进入 main，
 * 会话事实只经 `SessionSnapshot` 推送。诊断上报是单向旁路。
 */
export const ImeChannels = {
  Diagnostic: "answra:ime:diagnostic",
  SessionCommand: "answra:ime:session-command",
  SessionSnapshot: "answra:ime:session-snapshot",
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
  | {
      type: "show";
      anchor: ImeCandidateAnchor;
      targetId: string;
      generation: number;
    }
  | { type: "suspend"; targetId?: string; generation?: number }
  | { type: "clear"; targetId?: string; generation?: number };

export type ImeCandidateAction =
  | { type: "select"; index: number; targetId: string; generation: number }
  | { type: "navigate"; key: "PageUp" | "PageDown"; targetId: string; generation: number };

export interface ImeCandidateSnapshot {
  state: ImeState;
  targetId?: string;
  generation?: number;
}

export interface ImeCandidateChannelMap {
  [ImeCandidateChannels.Update]: {
    request: ImeCandidateUpdate;
    response: undefined;
  };
  [ImeCandidateChannels.State]: { request: undefined; response: ImeCandidateSnapshot };
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
  /** Native Rime mode reported by helper protocol v2. */
  inputMode: ImeInputMode;
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

export type ImeInputMode = "chinese" | "ascii";
export type ImeSessionPhase = "idle" | "owned" | "suspended" | "unavailable" | "disposed";

export interface ImeSessionOwner {
  windowId: number;
  webContentsId: number;
  targetId: string;
  generation: number;
}

/** Main-owned view of the engine session and its current input target. */
export interface ImeSessionSnapshot {
  phase: ImeSessionPhase;
  owner?: ImeSessionOwner;
  engine: Omit<ImeState, "committedText" | "handled"> & { inputMode: ImeInputMode };
  revision: number;
}

export type ImeSessionCommand =
  | {
      type: "acquireTarget";
      commandId: string;
      expectedRevision?: number;
      targetId: string;
    }
  | {
      type: "releaseTarget" | "suspend" | "resume";
      commandId: string;
      expectedRevision?: number;
      targetId: string;
      generation: number;
      /** Why the renderer drops the lease; logged with the main-side release. */
      reason?: string;
    }
  | {
      type: "processKey";
      commandId: string;
      expectedRevision?: number;
      targetId: string;
      generation: number;
      key: string;
      code: string;
      shift: boolean;
      ctrl: boolean;
      alt: boolean;
      meta: boolean;
      release?: boolean;
    }
  | {
      type: "cancelComposition";
      commandId: string;
      expectedRevision?: number;
      targetId: string;
      generation: number;
    }
  | {
      type: "selectCandidate";
      commandId: string;
      expectedRevision?: number;
      targetId: string;
      generation: number;
      index: number;
    };

export interface ImeSessionCommandResult {
  commandId: string;
  accepted: boolean;
  /** Whether Rime consumed the key; distinct from IPC/session acceptance. */
  engineHandled?: boolean;
  reason?:
    | "stale-owner"
    | "stale-revision"
    | "invalid-transition"
    | "engine-unavailable"
    | "command-id-conflict";
  snapshot: ImeSessionSnapshot;
  /** Present only when this command produced text; apply at most once per commandId. */
  commit?: { text: string; revision: number };
}

export interface ImeSessionSnapshotUpdate {
  snapshot: ImeSessionSnapshot;
}

export interface ImeKeyRequest {
  generation: number;
  key: string;
  code: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  release?: boolean;
}

export const IME_RENDERER_DIAGNOSTIC_EVENTS = [
  "input-mounted",
  "acquire-start",
  "acquire-result",
  "input-focus",
  "input-blur",
  "window-focus",
  "window-blur",
  "document-keydown",
  "selection-after-shortcut",
  "key-routing",
  "candidate-rendered",
  "release-called",
] as const;

export type ImeRendererDiagnosticEvent = (typeof IME_RENDERER_DIAGNOSTIC_EVENTS)[number];

export interface ImeDiagnosticRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImeDiagnosticElement {
  rect: ImeDiagnosticRect;
  text: string;
  display: string;
  visibility: string;
  opacity: string;
  childCount: number;
}

/** Local IME diagnostics. IME text is intentionally retained for troubleshooting. */
export interface ImeRendererDiagnostic {
  event: ImeRendererDiagnosticEvent;
  targetId: string;
  ownerTargetId?: string;
  source?: "input-focus" | "window-focus";
  reason?: string;
  generation?: number;
  activeElementTarget?: boolean;
  documentHasFocus?: boolean;
  /**
   * Whether this renderer still has the target registered as its active IME input
   * (`imeInputTargetCoordinator`). Replaces the old renderer-local `focusedRef`
   * copy of the focus fact.
   */
  targetRegistered?: boolean;
  imeAvailable?: boolean;
  imeEnabled?: boolean;
  composing?: boolean;
  accepted?: boolean;
  key?: string;
  keyCode?: string;
  keyKind?: "text" | "process" | "backspace" | "enter" | "navigation" | "other";
  repeat?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
  selectionStart?: number;
  selectionEnd?: number;
  selectionLength?: number;
  valueLength?: number;
  preedit?: string;
  committedText?: string;
  candidates?: ImeCandidate[];
  documentVisibility?: string;
  selectedIndex?: number;
  page?: number;
  candidateRoot?: ImeDiagnosticElement;
  candidatePopup?: ImeDiagnosticElement;
}

export interface ImeChannelMap {
  [ImeChannels.Diagnostic]: { request: ImeRendererDiagnostic; response: undefined };
  [ImeChannels.SessionCommand]: {
    request: ImeSessionCommand;
    response: ImeSessionCommandResult;
  };
  [ImeChannels.SessionSnapshot]: {
    request: undefined;
    response: ImeSessionSnapshotUpdate;
  };
}

export interface ImeLeaseResponse {
  state: ImeState;
  targetId?: string;
  generation?: number;
  accepted: boolean;
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
  [ConversationChannels.Send]: {
    request: ConversationSendCommand;
    response: { runId: string };
  };
  [ConversationChannels.AppendUserMessage]: {
    request: { conversationId: string; text: string };
    response: undefined;
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
  [ConversationChannels.GetConfig]: {
    request: undefined;
    response: ConversationModelSettingsView;
  };
  [ConversationChannels.Configure]: {
    request: ConversationModelSettings;
    response: ConversationModelSettingsView;
  };
  [ConversationChannels.GetApiKey]: { request: undefined; response: { apiKey: string | null } };
  [ConversationChannels.ClearConfig]: {
    request: undefined;
    response: ConversationModelSettingsView;
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

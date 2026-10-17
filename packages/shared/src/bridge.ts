import type {
  AmbientColorPayload,
  AuthLoginResult,
  AuthStatus,
  ContentSize,
  ConversationChange,
  ConversationModelConfig,
  ConversationSendRequest,
  ConversationSnapshot,
  ImeCandidateAction,
  ImeCandidateSnapshot,
  ImeCandidateUpdate,
  ImeRendererDiagnostic,
  ImeSessionCommand,
  ImeSessionCommandResult,
  ImeSessionSnapshot,
  InterviewAudioFrame,
  InterviewChange,
  RegionCaptureOptions,
  ReplyBarAction,
  ReplyBarPlacement,
  ReplyBarState,
  ScreenshotResult,
  WorkspaceChangeSet,
  WorkspaceCreateRequest,
  WorkspaceFileContent,
  WorkspaceNode,
} from "./channels";

/**
 * 悬浮条窗口的内容面板标识。
 *
 * `closed` 表示只显示悬浮导航条；其余值为打开的内容面板。
 * 面板只决定渲染器画什么，窗口大小由渲染器测量后经
 * `fitContent` 上报（见 channels.ts 的 FitContent 频道）。
 */
export type OverlayMode = "closed" | "chat" | "interview" | "notes" | "settings";

/** 渲染进程暴露给 UI 的桌面平台桥（由 preload 注入，测试可 mock）。 */
export interface DesktopBridge {
  /** 应用内输入法；隐身模式下未能启用时，文本输入保持阻断。 */
  imeAvailable?: boolean;
  imeDiagnostic?: (diagnostic: ImeRendererDiagnostic) => void;
  /** Authoritative IME session API: the only way the renderer mutates the engine session. */
  imeSessionCommand?: (command: ImeSessionCommand) => Promise<ImeSessionCommandResult>;
  getImeSessionSnapshot?: () => Promise<ImeSessionSnapshot>;
  onImeSessionSnapshot?: (listener: (snapshot: ImeSessionSnapshot) => void) => () => void;
  setImeCandidate?: (payload: ImeCandidateUpdate) => void;
  onImeCandidateAction?: (listener: (action: ImeCandidateAction) => void) => () => void;
  onImeCandidateState?: (listener: (snapshot: ImeCandidateSnapshot) => void) => () => void;
  requestImeCandidateState?: () => void;
  fitImeCandidate?: (size: ContentSize) => void;
  sendImeCandidateAction?: (action: ImeCandidateAction) => void;
  /** 上报外壳内容尺寸，主进程据此调整窗口大小。 */
  fitContent: (size: ContentSize) => void;
  /** 关闭应用窗口。 */
  close: () => void;
  /** Syncs task state to the separately protected reply window. */
  setReplyBarState?: (state: ReplyBarState | null) => void;
  /** Measures the detached reply window without resizing the toolbar HWND. */
  fitReplyBar?: (size: ContentSize) => void;
  onReplyBarPlacement?: (listener: (placement: ReplyBarPlacement) => void) => () => void;
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
  getConversationSnapshot?: (conversationId: string) => Promise<ConversationSnapshot>;
  createConversation?: (conversationId: string) => Promise<ConversationSnapshot>;
  readConversationEvents?: (
    conversationId: string,
    afterRevision: number,
  ) => Promise<ConversationChange[]>;
  sendConversationMessage?: (
    conversationId: string,
    request: ConversationSendRequest,
  ) => Promise<{ runId: string }>;
  cancelConversationRun?: (runId: string) => void;
  onConversationChange?: (listener: (change: ConversationChange) => void) => () => void;
  startInterview?: () => Promise<{ sessionId: string }>;
  stopInterview?: (sessionId: string) => void;
  sendInterviewAudioFrame?: (frame: InterviewAudioFrame) => void;
  onInterviewChange?: (listener: (change: InterviewChange) => void) => () => void;
  // ---- 本地工作区（合并笔记本与资料；浏览器预览/测试环境可未实现，调用方需判空） ----
  /** 读取缓存的上一工作区根目录；未选择过时 root 为 null。 */
  getWorkspaceRoot?: () => Promise<{ root: string | null }>;
  /** 弹出系统目录选择框；用户取消时 root 为 null，选择成功即缓存。 */
  pickWorkspaceRoot?: () => Promise<{ root: string | null }>;
  /** 列出根目录下的完整目录树。 */
  listWorkspaceTree?: () => Promise<WorkspaceNode[]>;
  /** 读取根目录内文件（相对路径）。 */
  readWorkspaceFile?: (path: string) => Promise<WorkspaceFileContent>;
  /** 以 UTF-8 写入根目录内文本文件（相对路径）。 */
  writeWorkspaceFile?: (path: string, text: string) => Promise<void>;
  /** 写入二进制文件（仅图片，base64；用于粘贴截图落盘）。 */
  writeWorkspaceBytes?: (path: string, dataBase64: string) => Promise<void>;
  /** 新建目录或空 md 文档。 */
  createWorkspaceEntry?: (request: WorkspaceCreateRequest) => Promise<void>;
  /** 删除文件或目录（目录递归）。 */
  deleteWorkspaceEntry?: (path: string) => Promise<void>;
  /** 订阅根目录内变更推送（watcher 防抖合并）；返回取消订阅函数。 */
  onWorkspaceChanged?: (listener: (change: WorkspaceChangeSet) => void) => () => void;
  // ---- 云端账号（登录解锁会员）；浏览器预览/测试环境可未实现，调用方需判空。----
  /** 在系统浏览器打开站点授权页；登录结果经 `onAuthStatus` 推送，本调用不等待。 */
  loginAccount?: () => Promise<AuthLoginResult>;
  /** 退出登录并清除本地凭据；返回登出后的状态。 */
  logoutAccount?: () => Promise<AuthStatus>;
  /** 查询当前账号与会员状态（不含 token）。 */
  getAuthStatus?: () => Promise<AuthStatus>;
  /** 订阅账号状态变化；返回取消订阅函数。 */
  onAuthStatus?: (listener: (status: AuthStatus) => void) => () => void;
}

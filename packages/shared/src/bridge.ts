import type {
  AgentConnectionState,
  AgentEventEnvelope,
  AmbientColorPayload,
  AuthLoginResult,
  AuthStatus,
  ContentSize,
  ConversationModelSettings,
  ConversationModelSettingsView,
  ConversationSelection,
  ConversationSendCommand,
  ConversationSnapshot,
  DesktopAnnouncement,
  InterviewChange,
  InterviewOnboardingPatch,
  InterviewOnboardingState,
  InterviewPcmFrame,
  InterviewProjectAddRequest,
  InterviewResumeImportRequest,
  InterviewResumePickResult,
  RegionCaptureOptions,
  ReplyBarAction,
  ReplyBarPlacement,
  ReplyBarState,
  ScreenshotResult,
  SurfaceActionEvent,
  SurfaceWindowState,
  UpdateInstallResult,
  UpdateStatus,
  WorkspaceChangeSet,
  WorkspaceCreateRequest,
  WorkspaceFileContent,
  WorkspaceNode,
} from "./channels";
import type { BotSummary } from "./schema";
import type { SurfacePresetId } from "./surfaces";

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
  /** Whether this renderer belongs to a packaged desktop application. */
  isPackaged?: boolean;
  /**
   * 面试对话功能是否可用。安装版尚未内置本地 ASR 模型且面试流程未开发完，
   * 主进程按打包态下发 false，UI 把面试模式渲染成「暂不支持」入口；开发态为 true。
   * 浏览器预览/测试环境可未实现，调用方需按缺省可用处理。
   */
  interviewAvailable?: boolean;
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
  // ---- 声明式浮窗（产品内置 preset；浏览器预览/测试环境可未实现） ----
  /** 产品代码请求主进程显示一个内置浮窗。 */
  showSurface?: (presetId: SurfacePresetId) => Promise<{ shown: boolean }>;
  /** 浮窗渲染器订阅当前内容。 */
  onSurfaceState?: (listener: (state: SurfaceWindowState) => void) => () => void;
  /** 浮窗渲染器就绪后请求当前内容。 */
  requestSurfaceState?: () => void;
  /** 浮窗渲染器请求关闭当前浮窗。 */
  dismissSurface?: () => void;
  /** 浮窗渲染器上报按钮动作。 */
  sendSurfaceAction?: (actionId: string) => void;
  /** 浮窗渲染器上报内容尺寸。 */
  fitSurface?: (size: ContentSize) => void;
  /** 主窗口订阅被转发的浮窗动作。 */
  onSurfaceAction?: (listener: (event: SurfaceActionEvent) => void) => () => void;
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
  getConversationSnapshot?: (conversationId: string) => Promise<ConversationSnapshot>;
  /** Lists selectable Bots; absent in browser preview/test environments. */
  listBots?: () => Promise<BotSummary[]>;
  createConversation?: (
    conversationId: string,
    selection?: ConversationSelection,
  ) => Promise<ConversationSnapshot>;
  /** 清空会话消息（仅空闲会话生效），返回清空后的权威 snapshot。 */
  clearConversationMessages?: (conversationId: string) => Promise<ConversationSnapshot>;
  readConversationEvents?: (
    conversationId: string,
    afterRevision: number,
  ) => Promise<AgentEventEnvelope[]>;
  sendConversationMessage?: (
    command: ConversationSendCommand,
  ) => Promise<{ runId: string; snapshot: ConversationSnapshot }>;
  appendConversationUserMessage?: (
    conversationId: string,
    text: string,
  ) => Promise<ConversationSnapshot>;
  cancelConversationRun?: (runId: string) => void;
  onConversationEvent?: (listener: (event: AgentEventEnvelope) => void) => () => void;
  /** Receives an authoritative transcript snapshot after an Agent-owned transcript write. */
  onConversationSnapshot?: (listener: (snapshot: ConversationSnapshot) => void) => () => void;
  /** 读取当前 Agent worker 连接状态；浏览器预览/测试环境可未实现。 */
  getConnectionState?: () => Promise<AgentConnectionState>;
  /** 订阅 Agent worker 连接状态变更；返回取消订阅函数。 */
  onConnectionState?: (listener: (state: AgentConnectionState) => void) => () => void;
  // ---- 模型来源（本地自定义端点 / 云端订阅；可选，实现由 preload 注入） ----
  /** 读取当前模型来源与本地端点摘要（不含 API Key）。 */
  getConversationConfig?: () => Promise<ConversationModelSettingsView>;
  /** 切换模型来源并保存本地端点；`apiKey` 留空表示沿用已保存的值。 */
  configureConversation?: (
    settings: ConversationModelSettings,
  ) => Promise<ConversationModelSettingsView>;
  /** 仅在渲染层需要明文时读取本机保存的 API Key。 */
  getConversationApiKey?: () => Promise<{ apiKey: string | null }>;
  /** 清除本地端点与 Key，恢复云端订阅。 */
  clearConversationConfig?: () => Promise<ConversationModelSettingsView>;
  startInterview?: (conversationId: string) => Promise<{ sessionId: string }>;
  sendInterviewMessage?: (
    conversationId: string,
    text: string,
  ) => Promise<{ runId: string; snapshot: ConversationSnapshot }>;
  stopInterview?: (sessionId: string) => Promise<void>;
  markInterviewCaptureReady?: (sessionId: string) => Promise<void>;
  failInterviewCapture?: (sessionId: string) => Promise<void>;
  sendInterviewPcmFrame?: (frame: InterviewPcmFrame) => void;
  onInterviewAudioCredit?: (
    listener: (credit: { sessionId: string; count: number }) => void,
  ) => () => void;
  onInterviewChange?: (listener: (change: InterviewChange) => void) => () => void;
  // ---- 面试首次引导（面试面板内三步；浏览器预览/测试环境可未实现） ----
  /** 读取首次引导状态；未实现时 UI 视为已完成，直接显示演练面板。 */
  getInterviewOnboardingState?: () => Promise<InterviewOnboardingState>;
  /** 主进程弹出系统文件框并导入 .md/.txt 简历；取消时 state 不变。 */
  pickInterviewResume?: () => Promise<InterviewResumePickResult>;
  /** 导入粘贴的简历文本；与文件选择共用解析和持久化路径。 */
  importInterviewResume?: (
    request: InterviewResumeImportRequest,
  ) => Promise<InterviewOnboardingState>;
  /** 保存步骤游标、项目选择和目标岗位；主进程只接受 pending 状态。 */
  updateInterviewOnboarding?: (
    patch: InterviewOnboardingPatch,
  ) => Promise<InterviewOnboardingState>;
  /** 手动添加简历里没有识别到的项目。 */
  addInterviewOnboardingProject?: (
    request: InterviewProjectAddRequest,
  ) => Promise<InterviewOnboardingState>;
  /** 完成引导；之后再次打开面试面板进入面试分身制作态。 */
  completeInterviewOnboarding?: () => Promise<InterviewOnboardingState>;
  /** 跳过引导；不阻断面试入口，之后不再自动弹出引导。 */
  skipInterviewOnboarding?: () => Promise<InterviewOnboardingState>;
  /** 从完成/跳过状态回到可编辑的引导步骤。 */
  reopenInterviewOnboarding?: () => Promise<InterviewOnboardingState>;
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
  /** 查询当前账号与会员状态（不含 token）；access token 有效时直接返回缓存。 */
  getAuthStatus?: () => Promise<AuthStatus>;
  /** 强制从云端同步账号与额度快照（打开账户面板时调用）。 */
  syncAuthStatus?: () => Promise<AuthStatus>;
  /** 订阅账号状态变化；返回取消订阅函数。 */
  onAuthStatus?: (listener: (status: AuthStatus) => void) => () => void;
  /** 读取当前账号可见的站点公告；未登录返回空列表。 */
  getAnnouncements?: () => Promise<DesktopAnnouncement[]>;
  /** 标记当前账号可见公告为已读。 */
  markAnnouncementRead?: (id: number) => Promise<void>;
  // ---- 应用更新（版本号、手动检查、立即安装）；浏览器预览/测试环境可未实现，调用方需判空。----
  /** 读取当前更新状态；包含当前版本号，设置页据此展示。 */
  getUpdateStatus?: () => Promise<UpdateStatus>;
  /** 手动检查更新；发现新版本后等待用户点击下载。 */
  checkForUpdates?: () => Promise<UpdateStatus>;
  /** 点击后的下载（也用于失败重试）；带进度推送。 */
  downloadUpdate?: () => Promise<UpdateStatus>;
  /** 立即重启并安装已下载的更新；失败时 started=false，应用仍运行。 */
  installUpdateNow?: () => Promise<UpdateInstallResult>;
  /** 订阅更新状态变化；返回取消订阅函数。 */
  onUpdateStatus?: (listener: (status: UpdateStatus) => void) => () => void;
}

import {
  AmbientChannels,
  type AmbientColorPayload,
  AuthChannels,
  type AuthStatus,
  CaptureChannels,
  type ContentSize,
  type ConversationChange,
  ConversationChannels,
  type ConversationModelSettings,
  type ConversationSendCommand,
  type DesktopBridge,
  type ImeCandidateAction,
  ImeCandidateChannels,
  type ImeCandidateSnapshot,
  type ImeCandidateUpdate,
  ImeChannels,
  type ImeKeyboardAck,
  type ImeKeyboardInput,
  type ImeRendererDiagnostic,
  type ImeSessionCommand,
  type ImeSessionCommandResult,
  type ImeSessionSnapshot,
  type ImeSessionSnapshotUpdate,
  type InterviewChange,
  InterviewChannels,
  type InterviewPcmFrame,
  type RegionCaptureOptions,
  type ReplyBarAction,
  type ReplyBarPlacement,
  type ReplyBarState,
  WindowChannels,
  type WorkspaceChangeSet,
  WorkspaceChannels,
  type WorkspaceCreateRequest,
} from "@answra/shared";
import { contextBridge, ipcRenderer } from "electron";

/**
 * 渲染进程唯一 API 面：window.answra。
 * 频道名与载荷类型来自 shared 契约，禁止在此之外新增 IPC 通道。
 */
const bridge: DesktopBridge = {
  // Set true only when the packaged librime bridge has been installed.
  imeAvailable: true,
  // 面试对话尚未开发完且安装版不带本地 ASR 模型：打包态置 false，UI 渲染「暂不支持」入口。
  interviewAvailable: !process.argv.includes("--answra-packaged=true"),
  imeDiagnostic: (diagnostic: ImeRendererDiagnostic) => {
    ipcRenderer.send(ImeChannels.Diagnostic, diagnostic);
  },
  imeSessionCommand: (command: ImeSessionCommand): Promise<ImeSessionCommandResult> =>
    ipcRenderer.invoke(ImeChannels.SessionCommand, command),
  getImeSessionSnapshot: async (): Promise<ImeSessionSnapshot> => {
    const update = (await ipcRenderer.invoke(
      ImeChannels.SessionSnapshot,
    )) as ImeSessionSnapshotUpdate;
    return update.snapshot;
  },
  onImeSessionSnapshot: (listener: (snapshot: ImeSessionSnapshot) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, update: ImeSessionSnapshotUpdate) =>
      listener(update.snapshot);
    ipcRenderer.on(ImeChannels.SessionSnapshot, wrapped);
    return () => ipcRenderer.removeListener(ImeChannels.SessionSnapshot, wrapped);
  },
  onImeKeyboardInput: (listener: (event: ImeKeyboardInput) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, input: ImeKeyboardInput) => listener(input);
    ipcRenderer.on(ImeChannels.KeyboardInput, wrapped);
    return () => ipcRenderer.removeListener(ImeChannels.KeyboardInput, wrapped);
  },
  ackImeKeyboardInput: (ack: ImeKeyboardAck): Promise<boolean> =>
    ipcRenderer.invoke(ImeChannels.KeyboardAck, ack),
  setImeCandidate: (payload: ImeCandidateUpdate) => {
    ipcRenderer.send(ImeCandidateChannels.Update, payload);
  },
  onImeCandidateAction: (listener: (action: ImeCandidateAction) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, action: ImeCandidateAction) =>
      listener(action);
    ipcRenderer.on(ImeCandidateChannels.OwnerAction, wrapped);
    return () => ipcRenderer.removeListener(ImeCandidateChannels.OwnerAction, wrapped);
  },
  onImeCandidateState: (listener: (snapshot: ImeCandidateSnapshot) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: ImeCandidateSnapshot) =>
      listener(snapshot);
    ipcRenderer.on(ImeCandidateChannels.State, wrapped);
    return () => ipcRenderer.removeListener(ImeCandidateChannels.State, wrapped);
  },
  requestImeCandidateState: () => {
    ipcRenderer.send(ImeCandidateChannels.Ready);
  },
  fitImeCandidate: (size: ContentSize) => {
    ipcRenderer.send(ImeCandidateChannels.Fit, size);
  },
  sendImeCandidateAction: (action: ImeCandidateAction) => {
    ipcRenderer.send(ImeCandidateChannels.Action, action);
  },
  fitContent: (size: ContentSize) => {
    ipcRenderer.send(WindowChannels.FitContent, size);
  },
  close: () => {
    ipcRenderer.send(WindowChannels.Close);
  },
  setReplyBarState: (state: ReplyBarState | null) => {
    ipcRenderer.send(WindowChannels.SetReplyBarState, state);
  },
  fitReplyBar: (size: ContentSize) => {
    ipcRenderer.send(WindowChannels.FitReplyBar, size);
  },
  onReplyBarPlacement: (listener: (placement: ReplyBarPlacement) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, placement: ReplyBarPlacement) =>
      listener(placement);
    ipcRenderer.on(WindowChannels.ReplyBarPlacement, wrapped);
    return () => ipcRenderer.removeListener(WindowChannels.ReplyBarPlacement, wrapped);
  },
  sendReplyBarAction: (action: ReplyBarAction) => {
    ipcRenderer.send(WindowChannels.ReplyBarAction, action);
  },
  onReplyBarAction: (listener: (action: ReplyBarAction) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, action: ReplyBarAction) => listener(action);
    ipcRenderer.on(WindowChannels.ReplyBarAction, wrapped);
    return () => ipcRenderer.removeListener(WindowChannels.ReplyBarAction, wrapped);
  },
  onReplyBarState: (listener: (state: ReplyBarState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: ReplyBarState) => listener(state);
    ipcRenderer.on(WindowChannels.ReplyBarState, wrapped);
    return () => ipcRenderer.removeListener(WindowChannels.ReplyBarState, wrapped);
  },
  requestReplyBarState: () => {
    ipcRenderer.send(WindowChannels.ReplyBarReady);
  },
  setStealth: (value: boolean) => {
    ipcRenderer.send(WindowChannels.SetStealth, value);
  },
  getStealthSupport: () => ipcRenderer.invoke(WindowChannels.GetStealthSupport),
  startRegionCapture: (options?: RegionCaptureOptions) =>
    ipcRenderer.invoke(CaptureChannels.StartRegionCapture, options),
  onAmbientColor: (listener: (payload: AmbientColorPayload) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: AmbientColorPayload) => {
      listener(payload);
    };
    ipcRenderer.on(AmbientChannels.AmbientColor, wrapped);
    return () => {
      ipcRenderer.removeListener(AmbientChannels.AmbientColor, wrapped);
    };
  },
  setAmbientFollow: (value: boolean) => {
    ipcRenderer.send(AmbientChannels.SetFollow, value);
  },
  getConversationSnapshot: (conversationId: string) =>
    ipcRenderer.invoke(ConversationChannels.GetSnapshot, { conversationId }),
  createConversation: (conversationId: string) =>
    ipcRenderer.invoke(ConversationChannels.Create, { conversationId }),
  clearConversationMessages: (conversationId: string) =>
    ipcRenderer.invoke(ConversationChannels.ClearMessages, { conversationId }),
  readConversationEvents: (conversationId: string, afterRevision: number) =>
    ipcRenderer.invoke(ConversationChannels.ReadEvents, { conversationId, afterRevision }),
  sendConversationMessage: (command: ConversationSendCommand) =>
    ipcRenderer.invoke(ConversationChannels.Send, command),
  appendConversationUserMessage: (conversationId: string, text: string) =>
    ipcRenderer.invoke(ConversationChannels.AppendUserMessage, { conversationId, text }),
  cancelConversationRun: (runId: string) =>
    ipcRenderer.send(ConversationChannels.Cancel, { runId }),
  onConversationChange: (listener: (change: ConversationChange) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, change: ConversationChange) =>
      listener(change);
    ipcRenderer.on(ConversationChannels.Change, wrapped);
    return () => {
      ipcRenderer.removeListener(ConversationChannels.Change, wrapped);
    };
  },
  getConversationConfig: () => ipcRenderer.invoke(ConversationChannels.GetConfig),
  configureConversation: (settings: ConversationModelSettings) =>
    ipcRenderer.invoke(ConversationChannels.Configure, settings),
  getConversationApiKey: () => ipcRenderer.invoke(ConversationChannels.GetApiKey),
  clearConversationConfig: () => ipcRenderer.invoke(ConversationChannels.ClearConfig),
  startInterview: (conversationId: string) =>
    ipcRenderer.invoke(InterviewChannels.Start, { conversationId }),
  stopInterview: (sessionId: string) => ipcRenderer.invoke(InterviewChannels.Stop, { sessionId }),
  markInterviewCaptureReady: (sessionId: string) =>
    ipcRenderer.invoke(InterviewChannels.CaptureReady, { sessionId }),
  failInterviewCapture: (sessionId: string) =>
    ipcRenderer.invoke(InterviewChannels.CaptureFailed, { sessionId }),
  sendInterviewPcmFrame: (frame: InterviewPcmFrame) => {
    ipcRenderer.send(InterviewChannels.AudioFrame, frame);
  },
  onInterviewAudioCredit: (listener: (credit: { sessionId: string; count: number }) => void) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      credit: { sessionId: string; count: number },
    ) => listener(credit);
    ipcRenderer.on(InterviewChannels.AudioCredit, wrapped);
    return () => ipcRenderer.removeListener(InterviewChannels.AudioCredit, wrapped);
  },
  onInterviewChange: (listener: (change: InterviewChange) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, change: InterviewChange) =>
      listener(change);
    ipcRenderer.on(InterviewChannels.Change, wrapped);
    return () => ipcRenderer.removeListener(InterviewChannels.Change, wrapped);
  },
  getWorkspaceRoot: () => ipcRenderer.invoke(WorkspaceChannels.GetRoot),
  pickWorkspaceRoot: () => ipcRenderer.invoke(WorkspaceChannels.PickRoot),
  listWorkspaceTree: () => ipcRenderer.invoke(WorkspaceChannels.ListTree),
  readWorkspaceFile: (path: string) => ipcRenderer.invoke(WorkspaceChannels.ReadFile, { path }),
  writeWorkspaceFile: (path: string, text: string) =>
    ipcRenderer.invoke(WorkspaceChannels.WriteFile, { path, text }),
  writeWorkspaceBytes: (path: string, dataBase64: string) =>
    ipcRenderer.invoke(WorkspaceChannels.WriteBytes, { path, dataBase64 }),
  createWorkspaceEntry: (request: WorkspaceCreateRequest) =>
    ipcRenderer.invoke(WorkspaceChannels.CreateEntry, request),
  deleteWorkspaceEntry: (path: string) =>
    ipcRenderer.invoke(WorkspaceChannels.DeleteEntry, { path }),
  onWorkspaceChanged: (listener: (change: WorkspaceChangeSet) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, change: WorkspaceChangeSet) =>
      listener(change);
    ipcRenderer.on(WorkspaceChannels.Changed, wrapped);
    return () => ipcRenderer.removeListener(WorkspaceChannels.Changed, wrapped);
  },
  loginAccount: () => ipcRenderer.invoke(AuthChannels.Login),
  logoutAccount: () => ipcRenderer.invoke(AuthChannels.Logout),
  getAuthStatus: () => ipcRenderer.invoke(AuthChannels.GetStatus),
  onAuthStatus: (listener: (status: AuthStatus) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, status: AuthStatus) => listener(status);
    ipcRenderer.on(AuthChannels.Status, wrapped);
    return () => ipcRenderer.removeListener(AuthChannels.Status, wrapped);
  },
  getAnnouncements: () => ipcRenderer.invoke(AuthChannels.ListAnnouncements),
  markAnnouncementRead: (id: number) => ipcRenderer.invoke(AuthChannels.MarkAnnouncementRead, id),
};

contextBridge.exposeInMainWorld("answra", bridge);

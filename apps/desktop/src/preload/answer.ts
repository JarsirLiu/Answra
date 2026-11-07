import {
  type AgentEventEnvelope,
  AmbientChannels,
  type AmbientColorPayload,
  AuthChannels,
  type AuthStatus,
  CaptureChannels,
  type ContentSize,
  ConversationChannels,
  type ConversationModelSettings,
  type ConversationSendCommand,
  type DesktopBridge,
  type RegionCaptureOptions,
  type ReplyBarAction,
  type ReplyBarPlacement,
  type ReplyBarState,
  UpdateChannels,
  type UpdateStatus,
  WindowChannels,
  type WorkspaceChangeSet,
  WorkspaceChannels,
  type WorkspaceCreateRequest,
} from "@answra/shared";
import { contextBridge, ipcRenderer } from "electron";

/** Answer profile preload API. Feature-specific IPC methods are absent from this bridge. */
const bridge: DesktopBridge = {
  fitContent: (size: ContentSize) => ipcRenderer.send(WindowChannels.FitContent, size),
  close: () => ipcRenderer.send(WindowChannels.Close),
  setReplyBarState: (state: ReplyBarState | null) =>
    ipcRenderer.send(WindowChannels.SetReplyBarState, state),
  fitReplyBar: (size: ContentSize) => ipcRenderer.send(WindowChannels.FitReplyBar, size),
  onReplyBarPlacement: (listener: (placement: ReplyBarPlacement) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, placement: ReplyBarPlacement) =>
      listener(placement);
    ipcRenderer.on(WindowChannels.ReplyBarPlacement, wrapped);
    return () => ipcRenderer.removeListener(WindowChannels.ReplyBarPlacement, wrapped);
  },
  sendReplyBarAction: (action: ReplyBarAction) =>
    ipcRenderer.send(WindowChannels.ReplyBarAction, action),
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
  requestReplyBarState: () => ipcRenderer.send(WindowChannels.ReplyBarReady),
  setStealth: (value: boolean) => ipcRenderer.send(WindowChannels.SetStealth, value),
  getStealthSupport: () => ipcRenderer.invoke(WindowChannels.GetStealthSupport),
  startRegionCapture: (options?: RegionCaptureOptions) =>
    ipcRenderer.invoke(CaptureChannels.StartRegionCapture, options),
  onAmbientColor: (listener: (payload: AmbientColorPayload) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: AmbientColorPayload) =>
      listener(payload);
    ipcRenderer.on(AmbientChannels.AmbientColor, wrapped);
    return () => ipcRenderer.removeListener(AmbientChannels.AmbientColor, wrapped);
  },
  setAmbientFollow: (value: boolean) => ipcRenderer.send(AmbientChannels.SetFollow, value),
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
  onConversationEvent: (listener: (event: AgentEventEnvelope) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, event: AgentEventEnvelope) =>
      listener(event);
    ipcRenderer.on(ConversationChannels.Event, wrapped);
    return () => ipcRenderer.removeListener(ConversationChannels.Event, wrapped);
  },
  getConversationConfig: () => ipcRenderer.invoke(ConversationChannels.GetConfig),
  configureConversation: (settings: ConversationModelSettings) =>
    ipcRenderer.invoke(ConversationChannels.Configure, settings),
  getConversationApiKey: () => ipcRenderer.invoke(ConversationChannels.GetApiKey),
  clearConversationConfig: () => ipcRenderer.invoke(ConversationChannels.ClearConfig),
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
  syncAuthStatus: () => ipcRenderer.invoke(AuthChannels.Sync),
  onAuthStatus: (listener: (status: AuthStatus) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, status: AuthStatus) => listener(status);
    ipcRenderer.on(AuthChannels.Status, wrapped);
    return () => ipcRenderer.removeListener(AuthChannels.Status, wrapped);
  },
  getAnnouncements: () => ipcRenderer.invoke(AuthChannels.ListAnnouncements),
  markAnnouncementRead: (id: number) => ipcRenderer.invoke(AuthChannels.MarkAnnouncementRead, id),
  getUpdateStatus: () => ipcRenderer.invoke(UpdateChannels.GetStatus),
  checkForUpdates: () => ipcRenderer.invoke(UpdateChannels.Check),
  downloadUpdate: () => ipcRenderer.invoke(UpdateChannels.Download),
  installUpdateNow: () => ipcRenderer.invoke(UpdateChannels.InstallNow),
  onUpdateStatus: (listener: (status: UpdateStatus) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => listener(status);
    ipcRenderer.on(UpdateChannels.Status, wrapped);
    return () => ipcRenderer.removeListener(UpdateChannels.Status, wrapped);
  },
};

contextBridge.exposeInMainWorld("answra", bridge);

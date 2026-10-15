import {
  AmbientChannels,
  type AmbientColorPayload,
  CaptureChannels,
  type ContentSize,
  type ConversationChange,
  ConversationChannels,
  type ConversationModelConfig,
  type ConversationSendRequest,
  type DesktopBridge,
  type ImeCandidateAction,
  ImeCandidateChannels,
  type ImeCandidateSnapshot,
  type ImeCandidateUpdate,
  ImeChannels,
  type ImeKeyRequest,
  type ImeRendererDiagnostic,
  type ImeState,
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
  imeAcquire: (targetId: string) => ipcRenderer.invoke(ImeChannels.Acquire, { targetId }),
  imeRelease: (generation: number) => ipcRenderer.invoke(ImeChannels.Release, { generation }),
  imeConfirmFocus: (targetId: string, generation: number) =>
    ipcRenderer.invoke(ImeChannels.ConfirmFocus, { targetId, generation }),
  imeKey: (request: ImeKeyRequest) => ipcRenderer.invoke(ImeChannels.Key, request),
  imeDiagnostic: (diagnostic: ImeRendererDiagnostic) => {
    ipcRenderer.send(ImeChannels.Diagnostic, diagnostic);
  },
  imeSelect: (index: number, generation: number) =>
    ipcRenderer.invoke(ImeChannels.Select, { index, generation }),
  imeReset: (generation: number) => ipcRenderer.invoke(ImeChannels.Reset, { generation }),
  onImeChange: (listener: (state: ImeState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: ImeState) => listener(state);
    ipcRenderer.on(ImeChannels.Change, wrapped);
    return () => ipcRenderer.removeListener(ImeChannels.Change, wrapped);
  },
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
  configureConversation: (config: ConversationModelConfig) =>
    ipcRenderer.invoke(ConversationChannels.Configure, config),
  getConversationConfig: () => ipcRenderer.invoke(ConversationChannels.GetConfig),
  getConversationApiKey: () => ipcRenderer.invoke(ConversationChannels.GetApiKey),
  getConversationSnapshot: (conversationId: string) =>
    ipcRenderer.invoke(ConversationChannels.GetSnapshot, { conversationId }),
  createConversation: (conversationId: string) =>
    ipcRenderer.invoke(ConversationChannels.Create, { conversationId }),
  readConversationEvents: (conversationId: string, afterRevision: number) =>
    ipcRenderer.invoke(ConversationChannels.ReadEvents, { conversationId, afterRevision }),
  sendConversationMessage: (conversationId: string, request: ConversationSendRequest) =>
    ipcRenderer.invoke(ConversationChannels.Send, { conversationId, request }),
  cancelConversationRun: (runId: string) =>
    ipcRenderer.send(ConversationChannels.Cancel, { runId }),
  onConversationChange: (listener: (change: ConversationChange) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, change: ConversationChange) =>
      listener(change);
    ipcRenderer.on(ConversationChannels.Change, wrapped);
    return () => ipcRenderer.removeListener(ConversationChannels.Change, wrapped);
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
};

contextBridge.exposeInMainWorld("answra", bridge);

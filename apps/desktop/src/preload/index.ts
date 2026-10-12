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
  type RegionCaptureOptions,
  type ReplyBarAction,
  type ReplyBarPlacement,
  type ReplyBarState,
  WindowChannels,
} from "@answra/shared";
import { contextBridge, ipcRenderer } from "electron";

/**
 * 渲染进程唯一 API 面：window.answra。
 * 频道名与载荷类型来自 shared 契约，禁止在此之外新增 IPC 通道。
 */
const bridge: DesktopBridge = {
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
};

contextBridge.exposeInMainWorld("answra", bridge);

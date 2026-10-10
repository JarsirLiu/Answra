import { type ContentSize, type DesktopBridge, WindowChannels } from "@exam-assistant/shared";
import { contextBridge, ipcRenderer } from "electron";

/**
 * 渲染进程唯一 API 面：window.examAssistant。
 * 频道名与载荷类型来自 shared 契约，禁止在此之外新增 IPC 通道。
 */
const bridge: DesktopBridge = {
  fitContent: (size: ContentSize) => {
    ipcRenderer.send(WindowChannels.FitContent, size);
  },
  close: () => {
    ipcRenderer.send(WindowChannels.Close);
  },
};

contextBridge.exposeInMainWorld("examAssistant", bridge);

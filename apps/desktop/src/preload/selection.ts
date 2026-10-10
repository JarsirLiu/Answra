import type { RegionSelection } from "@answra/shared";
import { CaptureChannels } from "@answra/shared";
import { contextBridge, ipcRenderer } from "electron";

/**
 * 框选 overlay 专用桥：window.answraSelection。
 * 仅暴露「确认选区 / 取消」两个动作，频道与载荷类型来自 shared 契约。
 */
contextBridge.exposeInMainWorld("answraSelection", {
  confirm: (selection: RegionSelection) => {
    ipcRenderer.send(CaptureChannels.RegionSelected, selection);
  },
  cancel: () => {
    ipcRenderer.send(CaptureChannels.RegionCancelled);
  },
});

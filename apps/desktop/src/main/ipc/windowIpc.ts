import { WindowChannels } from "@exam-assistant/shared";
import { ipcMain } from "electron";
import { getWindow, isWindowFromSender, resizeWindowForMode } from "../window";

/**
 * 窗口控制 IPC。
 * 频道常量与载荷类型来自 @exam-assistant/shared/channels，
 * 渲染进程只能通过 preload 暴露的桥访问，不直接触碰 ipcRenderer。
 */
export function registerWindowIpc(): void {
  ipcMain.on(WindowChannels.SetMode, (event, mode) => {
    if (!isWindowFromSender(getWindow(), event)) return;
    resizeWindowForMode(mode);
  });

  ipcMain.on(WindowChannels.Close, (event) => {
    const window = getWindow();
    if (!isWindowFromSender(window, event)) return;
    window?.close();
  });
}

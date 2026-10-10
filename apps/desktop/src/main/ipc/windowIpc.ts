import { type ContentSize, WindowChannels } from "@answra/shared";
import { ipcMain } from "electron";
import {
  applyStealth,
  getWindow,
  isStealthSupported,
  isWindowFromSender,
  resizeWindowToContent,
} from "../window";

/**
 * 窗口控制 IPC。
 * 频道常量与载荷类型来自 @answra/shared/channels，
 * 渲染进程只能通过 preload 暴露的桥访问，不直接触碰 ipcRenderer。
 */
export function registerWindowIpc(): void {
  ipcMain.on(WindowChannels.FitContent, (event, size: ContentSize) => {
    if (!isWindowFromSender(getWindow(), event)) return;
    if (!isValidSize(size)) return;
    resizeWindowToContent(size);
  });

  ipcMain.on(WindowChannels.Close, (event) => {
    const window = getWindow();
    if (!isWindowFromSender(window, event)) return;
    window?.close();
  });

  ipcMain.on(WindowChannels.SetStealth, (event, value: boolean) => {
    if (!isWindowFromSender(getWindow(), event)) return;
    if (typeof value !== "boolean") return;
    applyStealth(value);
  });

  ipcMain.handle(WindowChannels.GetStealthSupport, (event) => {
    if (!isWindowFromSender(getWindow(), event)) return false;
    return isStealthSupported();
  });
}

function isValidSize(size: ContentSize): boolean {
  return (
    typeof size === "object" &&
    size !== null &&
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0
  );
}

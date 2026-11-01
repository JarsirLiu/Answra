/** 更新相关 IPC：只接受主窗口的调用，并把 main 侧状态推回同一窗口。 */

import { UpdateChannels } from "@answra/shared";
import { type IpcMainInvokeEvent, ipcMain } from "electron";
import { getWindow, isWindowFromSender } from "../window";
import type { UpdateController } from "./updateController";

/** 注册更新 IPC；返回清理函数（退出前注销 handler 与状态推送）。 */
export function registerUpdateIpc(controller: UpdateController): () => void {
  ipcMain.handle(UpdateChannels.GetStatus, (event) => {
    assertMainWindow(event);
    return controller.getStatus();
  });
  ipcMain.handle(UpdateChannels.Check, (event) => {
    assertMainWindow(event);
    return controller.check({ manual: true });
  });
  ipcMain.handle(UpdateChannels.Download, (event) => {
    assertMainWindow(event);
    return controller.download();
  });
  ipcMain.handle(UpdateChannels.InstallNow, (event) => {
    assertMainWindow(event);
    return controller.installNow();
  });

  const unsubscribe = controller.subscribe((status) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(UpdateChannels.Status, status);
  });

  return () => {
    unsubscribe();
    ipcMain.removeHandler(UpdateChannels.GetStatus);
    ipcMain.removeHandler(UpdateChannels.Check);
    ipcMain.removeHandler(UpdateChannels.Download);
    ipcMain.removeHandler(UpdateChannels.InstallNow);
  };
}

function assertMainWindow(event: IpcMainInvokeEvent): void {
  if (!isWindowFromSender(getWindow(), event)) throw new Error("更新操作来源无效");
}

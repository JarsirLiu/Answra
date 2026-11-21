import { RemoteHostChannels } from "@answra/shared";
import { ipcMain } from "electron";
import { getWindow, isWindowFromSender, sendRemoteHostStatus } from "../window";
import type { DesktopRemoteHostService } from "./host/desktopRemoteHostService";

/** 远程 host IPC：密钥只在创建响应中返回一次，状态推送永远不含明文。 */
export function registerRemoteHostIpc(service: DesktopRemoteHostService): void {
  service.onStatus(sendRemoteHostStatus);

  ipcMain.handle(RemoteHostChannels.GetStatus, (event) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用");
    return service.getStatus();
  });
  ipcMain.handle(RemoteHostChannels.Connect, (event) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用");
    return service.connect();
  });
  ipcMain.handle(RemoteHostChannels.Disconnect, (event) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用");
    return service.disconnect();
  });
}

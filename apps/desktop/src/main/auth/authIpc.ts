import { AuthChannels } from "@answra/shared";
import { ipcMain } from "electron";
import { getWindow, isWindowFromSender } from "../window";
import type { AuthService } from "./authService";

/** 账号 IPC：handler 只做来源校验与转发，token 永不经过渲染层。 */
export function registerAuthIpc(service: AuthService): void {
  ipcMain.handle(AuthChannels.Login, (event) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用");
    return service.login();
  });
  ipcMain.handle(AuthChannels.Logout, (event) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用");
    return service.logout();
  });
  ipcMain.handle(AuthChannels.GetStatus, (event) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用");
    return service.getStatus();
  });
}

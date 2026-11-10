import { ConnectionChannels } from "@answra/shared";
import { type IpcMainInvokeEvent, ipcMain } from "electron";
import type { AgentService } from "../conversation/agentService";
import {
  getWindow,
  isReplyBarWindowFromSender,
  isWindowFromSender,
  sendConnectionState,
} from "../window";

/** Agent worker 连接状态的只读 IPC 面；状态由连接域唯一持有。 */
export function registerConnectionIpc(service: AgentService): void {
  ipcMain.handle(ConnectionChannels.GetState, (event) => {
    if (!isAppWindowFromSender(event)) throw new Error("非法调用方");
    return service.getConnectionState();
  });
  service.onConnectionState(sendConnectionState);
}

function isAppWindowFromSender(event: IpcMainInvokeEvent): boolean {
  return isWindowFromSender(getWindow(), event) || isReplyBarWindowFromSender(event);
}

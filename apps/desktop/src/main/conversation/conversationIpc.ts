import {
  ConversationChannels,
  type ConversationModelConfig,
  type ConversationSendRequest,
} from "@answra/shared";
import { ipcMain } from "electron";
import { getWindow, isWindowFromSender } from "../window";
import type { AppService } from "./appService";

export function registerConversationIpc(service: AppService): void {
  ipcMain.handle(ConversationChannels.GetConfig, (event) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用方");
    return service.getConfig();
  });
  ipcMain.handle(ConversationChannels.Configure, async (event, config: ConversationModelConfig) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用方");
    await service.configure(config);
  });
  ipcMain.handle(ConversationChannels.Send, (event, request: ConversationSendRequest) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用方");
    return service.send(request);
  });
  ipcMain.on(ConversationChannels.Cancel, (event, payload: { runId: string }) => {
    if (!isWindowFromSender(getWindow(), event) || typeof payload?.runId !== "string") return;
    service.cancel(payload.runId);
  });
  service.onEvent((payload) => {
    const window = getWindow();
    if (window && !window.isDestroyed())
      window.webContents.send(ConversationChannels.Event, payload);
  });
}

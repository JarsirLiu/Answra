import {
  ConversationChannels,
  type ConversationModelConfig,
  type ConversationSendCommand,
} from "@answra/shared";
import { ipcMain } from "electron";
import { getWindow, isWindowFromSender } from "../window";
import type { AppService } from "./appService";

export function registerConversationIpc(service: AppService): void {
  ipcMain.handle(ConversationChannels.GetConfig, (event) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用方");
    return service.getConfig();
  });
  ipcMain.handle(ConversationChannels.GetApiKey, (event) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用方");
    return service.getApiKey();
  });
  ipcMain.handle(ConversationChannels.Configure, async (event, config: ConversationModelConfig) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用方");
    await service.configure(config);
  });
  ipcMain.handle(ConversationChannels.Send, (event, payload: ConversationSendCommand) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用方");
    return service.send(payload.conversationId, payload.request);
  });
  ipcMain.handle(ConversationChannels.GetSnapshot, (event, payload: { conversationId: string }) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用方");
    return service.getSnapshot(payload.conversationId);
  });
  ipcMain.handle(ConversationChannels.Create, (event, payload: { conversationId: string }) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用方");
    return service.createConversation(payload.conversationId);
  });
  ipcMain.handle(
    ConversationChannels.ReadEvents,
    (event, payload: { conversationId: string; afterRevision: number }) => {
      if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用方");
      return service.readEvents(payload.conversationId, payload.afterRevision);
    },
  );
  ipcMain.on(ConversationChannels.Cancel, (event, payload: { runId: string }) => {
    if (!isWindowFromSender(getWindow(), event) || typeof payload?.runId !== "string") return;
    service.cancel(payload.runId);
  });
  service.onChange((payload) => {
    const window = getWindow();
    if (window && !window.isDestroyed())
      window.webContents.send(ConversationChannels.Change, payload);
  });
}

/**
 * TTS IPC：设置读写、手动朗读与停止；音频与失败由 main 主动推送。
 *
 * 频道与载荷类型来自 `@answra/shared`；这里是唯一校验入口，主进程核心信任校验后的类型。
 */
import {
  isTtsProviderId,
  TtsChannels,
  type TtsSettingsPatch,
  type TtsSpeakRequest,
  type TtsStopPayload,
} from "@answra/shared";
import { type IpcMainInvokeEvent, ipcMain } from "electron";
import { getWindow, isWindowFromSender } from "../window";
import type { TtsService } from "./ttsService";
import type { TtsSettingsStore } from "./ttsSettingsStore";

export interface TtsIpcHandle {
  dispose(): void;
}

export function registerTtsIpc(settings: TtsSettingsStore, service: TtsService): TtsIpcHandle {
  ipcMain.handle(TtsChannels.GetSettings, async (event) => {
    assertCaller(event);
    return settings.view();
  });

  ipcMain.handle(TtsChannels.SaveSettings, async (event, payload: unknown) => {
    assertCaller(event);
    if (!isSettingsPatch(payload)) throw new Error("TTS 设置无效");
    return settings.save(payload);
  });

  ipcMain.handle(TtsChannels.RevealApiKey, async (event, payload: unknown) => {
    assertCaller(event);
    if (!isProviderPayload(payload)) throw new Error("TTS provider 无效");
    return { apiKey: await settings.revealApiKey(payload.providerId) };
  });

  ipcMain.handle(TtsChannels.Speak, async (event, payload: unknown) => {
    assertCaller(event);
    if (!isSpeakRequest(payload)) throw new Error("朗读请求无效");
    return service.speak(payload);
  });

  ipcMain.handle(TtsChannels.Stop, async (event, payload: unknown) => {
    assertCaller(event);
    if (!isStopPayload(payload)) throw new Error("停止请求无效");
    service.stop(payload);
  });

  return {
    dispose(): void {
      ipcMain.removeHandler(TtsChannels.GetSettings);
      ipcMain.removeHandler(TtsChannels.SaveSettings);
      ipcMain.removeHandler(TtsChannels.RevealApiKey);
      ipcMain.removeHandler(TtsChannels.Speak);
      ipcMain.removeHandler(TtsChannels.Stop);
    },
  };
}

function assertCaller(event: IpcMainInvokeEvent): void {
  if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用方");
}

function isSettingsPatch(value: unknown): value is TtsSettingsPatch {
  if (!isRecord(value)) return false;
  return value.provider === undefined || value.provider === null || isRecord(value.provider);
}

function isProviderPayload(value: unknown): value is { providerId: string } {
  return (
    isRecord(value) && typeof value.providerId === "string" && isTtsProviderId(value.providerId)
  );
}

function isSpeakRequest(value: unknown): value is TtsSpeakRequest {
  return (
    isRecord(value) &&
    typeof value.messageId === "string" &&
    value.messageId.length > 0 &&
    value.messageId.length <= 200 &&
    typeof value.text === "string" &&
    value.text.trim() !== "" &&
    value.text.length <= 32_000
  );
}

function isStopPayload(value: unknown): value is TtsStopPayload {
  return (
    isRecord(value) &&
    (value.conversationId === null ||
      (typeof value.conversationId === "string" && value.conversationId.length <= 128))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import {
  type ContentSize,
  isSurfacePresetId,
  SurfaceChannels,
  type SurfacePresetId,
} from "@answra/shared";
import { ipcMain } from "electron";
import {
  dismissSurface,
  getWindow,
  handleSurfaceAction,
  isSurfaceWindowFromSender,
  isWindowFromSender,
  resizeSurfaceWindow,
  sendSurfaceState,
  showSurface,
} from "../window";

/** 浮窗 IPC：产品渲染器只能按预设 id 发起，浮窗渲染器只能回传动作 id。 */
export function registerSurfaceIpc(): void {
  ipcMain.handle(SurfaceChannels.Show, (event, payload: unknown) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用");
    if (!isShowRequest(payload)) return { shown: false };
    return showSurface(payload.presetId);
  });

  ipcMain.on(SurfaceChannels.Ready, (event) => {
    if (!isSurfaceWindowFromSender(event)) return;
    sendSurfaceState();
  });

  ipcMain.on(SurfaceChannels.Dismiss, (event) => {
    if (!isSurfaceWindowFromSender(event)) return;
    dismissSurface();
  });

  ipcMain.on(SurfaceChannels.Action, (event, payload: unknown) => {
    if (!isSurfaceWindowFromSender(event) || !isActionRequest(payload)) return;
    handleSurfaceAction(payload.actionId);
  });

  ipcMain.on(SurfaceChannels.Fit, (event, size: ContentSize) => {
    if (!isSurfaceWindowFromSender(event) || !isValidSize(size)) return;
    resizeSurfaceWindow(size);
  });
}

function isShowRequest(payload: unknown): payload is { presetId: SurfacePresetId } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "presetId" in payload &&
    isSurfacePresetId(payload.presetId)
  );
}

function isActionRequest(payload: unknown): payload is { actionId: string } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "actionId" in payload &&
    typeof payload.actionId === "string" &&
    payload.actionId.length > 0 &&
    payload.actionId.length <= 40
  );
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

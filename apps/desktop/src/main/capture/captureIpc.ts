import type { RegionSelection, ScreenshotResult } from "@answra/shared";
import { CaptureChannels } from "@answra/shared";
import type { IpcMainEvent } from "electron";
import { ipcMain } from "electron";
import { getWindow, isWindowFromSender } from "../window";
import { captureDisplay, cropToDataUrl, ScreenCaptureError } from "./captureService";
import {
  closeSelectionWindows,
  createSelectionWindows,
  getActiveSelectionWindows,
} from "./selectionWindow";

/**
 * 区域截图 IPC 编排：
 * 1. 渲染进程 invoke StartRegionCapture → 隐藏主窗口（避免入镜）→ 弹出框选 overlay；
 * 2. overlay 上报选区/取消 → 关闭 overlay → 恢复主窗口；
 * 3. 捕获所选显示器整屏 → 逻辑选区换算物理像素 → 裁剪编码 PNG data URL 返回。
 */
export function registerCaptureIpc(): void {
  ipcMain.handle(CaptureChannels.StartRegionCapture, async (event): Promise<ScreenshotResult> => {
    if (!isWindowFromSender(getWindow(), event)) {
      return { message: "非法调用方", ok: false, reason: "error" };
    }
    if (pendingCapture) {
      return { message: "已有截图正在进行", ok: false, reason: "error" };
    }
    return runRegionCapture();
  });

  ipcMain.on(CaptureChannels.RegionSelected, (event, selection: RegionSelection) => {
    if (!isValidSelection(selection)) return;
    settleFromOverlay(event, selection);
  });

  ipcMain.on(CaptureChannels.RegionCancelled, (event) => {
    settleFromOverlay(event, null);
  });
}

let pendingCapture: ((selection: RegionSelection | null) => void) | undefined;

async function runRegionCapture(): Promise<ScreenshotResult> {
  const mainWindow = getWindow();
  const wasVisible = mainWindow?.isVisible() ?? false;
  let selection: RegionSelection | null;
  try {
    mainWindow?.hide();
    const overlays = createSelectionWindows();
    if (overlays.length === 0) {
      return { message: "没有可用的显示器", ok: false, reason: "unavailable" };
    }
    selection = await new Promise<RegionSelection | null>((resolve) => {
      pendingCapture = resolve;
    });
  } finally {
    pendingCapture = undefined;
    closeSelectionWindows();
    // showInactive 恢复可见但不抢焦点，避免打断截图后的输入流
    if (wasVisible) mainWindow?.showInactive();
  }

  if (!selection) return { ok: false, reason: "cancelled" };

  try {
    const capture = await captureDisplay(selection.displayId);
    return cropToDataUrl(capture, selection.rect);
  } catch (error) {
    if (error instanceof ScreenCaptureError) {
      return { message: error.message, ok: false, reason: error.reason };
    }
    return {
      message: error instanceof Error ? error.message : String(error),
      ok: false,
      reason: "error",
    };
  }
}

/** 校验事件来自框选 overlay 且仍有等待中的截图会话。 */
function settleFromOverlay(event: IpcMainEvent, selection: RegionSelection | null): void {
  if (!pendingCapture) return;
  const fromOverlay = getActiveSelectionWindows().some(
    (overlay) => overlay.webContents === event.sender,
  );
  if (!fromOverlay) return;
  pendingCapture(selection);
}

function isValidSelection(selection: unknown): selection is RegionSelection {
  if (typeof selection !== "object" || selection === null) return false;
  const candidate = selection as RegionSelection;
  return Number.isFinite(candidate.displayId) && isValidRect(candidate.rect);
}

function isValidRect(rect: unknown): boolean {
  if (typeof rect !== "object" || rect === null) return false;
  const candidate = rect as RegionSelection["rect"];
  return (
    [candidate.x, candidate.y, candidate.width, candidate.height].every((value) =>
      Number.isFinite(value),
    ) &&
    candidate.width > 0 &&
    candidate.height > 0
  );
}

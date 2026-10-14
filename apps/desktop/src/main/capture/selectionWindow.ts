import path from "node:path";
import { BrowserWindow, screen } from "electron";
import { attachNonActivatingWindow } from "../windowInteractionPolicy";
import type { WindowPolicyDescriptor } from "../windowPolicyRegistry";

/**
 * 区域框选 overlay 窗口。
 *
 * 每个显示器盖一个透明全屏窗（逻辑边界 = display.bounds），用户在暗色遮罩上
 * 拖拽出选区。仅会议隐身开启时排除此窗口，普通应用内截图不能改变系统截图结果。
 */

const activeWindows = new Set<BrowserWindow>();
export interface SelectionWindowPolicyHost {
  registerWindowPolicy: (window: BrowserWindow, descriptor: WindowPolicyDescriptor) => void;
  prepareWindowToShow: (window: BrowserWindow) => boolean;
}

/** 为所有显示器创建框选 overlay 并显示；返回创建的窗口列表。 */
export function createSelectionWindows(
  line: string | undefined,
  stealth: boolean,
  policyHost: SelectionWindowPolicyHost,
): BrowserWindow[] {
  closeSelectionWindows();
  for (const display of screen.getAllDisplays()) {
    const selectionWindow = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "../preload/selection.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    policyHost.registerWindowPolicy(selectionWindow, {
      role: "selection-overlay",
      captureProtection: "stealth-only",
      failClosed: true,
    });
    // screen-saver 层级确保压过主窗口的 floating 层
    selectionWindow.setAlwaysOnTop(true, "screen-saver");
    // The selection surface only needs mouse input. On Windows, keep the
    // meeting application foreground while the user drags the selection.
    attachNonActivatingWindow(selectionWindow, { requiresKeyboardChannel: false });
    selectionWindow.once("ready-to-show", () => {
      if (policyHost.prepareWindowToShow(selectionWindow)) selectionWindow.showInactive();
      else selectionWindow.close();
    });
    selectionWindow.once("closed", () => activeWindows.delete(selectionWindow));
    activeWindows.add(selectionWindow);
    void selectionWindow.loadFile(path.join(__dirname, "../capture/selection.html"), {
      query: {
        displayId: String(display.id),
        ...(line ? { line } : {}),
        ...(stealth ? { stealth: "true" } : {}),
      },
    });
  }
  return [...activeWindows];
}

/** 关闭并清理全部框选 overlay。 */
export function closeSelectionWindows(): void {
  for (const selectionWindow of activeWindows) {
    if (!selectionWindow.isDestroyed()) selectionWindow.close();
  }
  activeWindows.clear();
}

/** 当前存活的框选 overlay（用于校验上报事件确实来自 overlay）。 */
export function getActiveSelectionWindows(): BrowserWindow[] {
  return [...activeWindows].filter((selectionWindow) => !selectionWindow.isDestroyed());
}

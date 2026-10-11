import os from "node:os";
import { app, type BrowserWindow } from "electron";
import {
  getWindowCaptureDiagnostics,
  isWindowCaptureProtectionSupported,
  setWindowCaptureProtection,
} from "./windowCaptureProtection";

export interface WindowStealthControllerHost {
  getMainWindow: () => BrowserWindow | undefined;
  setReplyBarProtection: (enabled: boolean) => void;
}

/** 隐身是窗口策略，不参与面板、回复条或截图工作流的状态机。 */
export function createWindowStealthController(host: WindowStealthControllerHost) {
  let enabled = false;

  function refresh(reason = "window-restore"): void {
    const window = host.getMainWindow();
    if (!enabled || !window || window.isDestroyed()) return;
    setWindowCaptureProtection(window, true);
    if (reason === "diagnostic")
      console.info("[window][capture-protection] refreshed", getWindowCaptureDiagnostics(window));
  }

  function apply(value: boolean): void {
    const window = host.getMainWindow();
    if (!window || window.isDestroyed()) {
      console.warn("[settings][stealth] cannot apply state: main window unavailable");
      return;
    }
    enabled = value;
    const applied = setWindowCaptureProtection(window, value);
    host.setReplyBarProtection(value);
    window.setSkipTaskbar(value);
    if (process.platform === "darwin") value ? app.dock?.hide() : app.dock?.show();
    console.info("[settings][stealth] application result", {
      enabled: value,
      contentProtectionApplied: applied,
      windowId: window.id,
    });
  }

  return {
    apply,
    isEnabled: () => enabled,
    isSupported: () => isWindowCaptureProtectionSupported(process.platform, os.release()),
    refresh,
  };
}

import os from "node:os";
import { app, type BrowserWindow } from "electron";
import { getWindowCaptureDiagnostics, isWindowCaptureProtectionSupported } from "./windowCaptureProtection";

export interface WindowStealthControllerHost {
  getMainWindow: () => BrowserWindow | undefined;
  applyWindowPolicies: (enabled: boolean) => boolean;
  refreshWindowPolicies: (reason: string) => boolean;
}

/** Owns capture protection and taskbar visibility; stealth never enables text input. */
export function createWindowStealthController(host: WindowStealthControllerHost) {
  let enabled = false;
  function refresh(reason = "window-restore"): void {
    if (!enabled || !host.getMainWindow()) return;
    host.refreshWindowPolicies(reason);
    if (reason === "diagnostic")
      console.info("[window][capture-protection] refreshed", getWindowCaptureDiagnostics(host.getMainWindow()!));
  }
  function apply(value: boolean): void {
    const window = host.getMainWindow();
    if (!window || window.isDestroyed()) return;
    enabled = value;
    const applied = host.applyWindowPolicies(value);
    window.setSkipTaskbar(value);
    if (process.platform === "darwin") value ? app.dock?.hide() : app.dock?.show();
    console.info("[settings][stealth] application result", { enabled: value, contentProtectionApplied: applied, windowId: window.id });
  }
  return { apply, isEnabled: () => enabled, isSupported: () => isWindowCaptureProtectionSupported(process.platform, os.release()), refresh };
}

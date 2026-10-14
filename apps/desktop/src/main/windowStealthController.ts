import os from "node:os";
import { app, type BrowserWindow } from "electron";
import koffi from "koffi";
import {
  getWindowCaptureDiagnostics,
  isWindowCaptureProtectionSupported,
  setWindowCaptureProtection,
} from "./windowCaptureProtection";

export interface WindowStealthControllerHost {
  getMainWindow: () => BrowserWindow | undefined;
  setReplyBarProtection: (enabled: boolean) => void;
  setImeCandidateProtection?: (enabled: boolean) => void;
  setReplyBarInputMethod?: (enabled: boolean) => void;
}

const nativePointer = koffi.pointer("void");
const immAssociateContext =
  process.platform === "win32"
    ? koffi
        .load("imm32.dll")
        .func("ImmAssociateContext", nativePointer, [nativePointer, nativePointer])
    : undefined;
const immAssociateContextEx =
  process.platform === "win32"
    ? koffi
        .load("imm32.dll")
        .func("ImmAssociateContextEx", "int", [nativePointer, nativePointer, "uint"])
    : undefined;
const immDisableIme =
  process.platform === "win32"
    ? koffi.load("imm32.dll").func("ImmDisableIME", "int", ["uint32"])
    : undefined;
let electronThreadImeDisabled: boolean | undefined;
let lastImeIsolationResult: boolean | undefined;

export function setNativeImeEnabled(window: BrowserWindow, enabled: boolean): boolean {
  if (window.isDestroyed()) return false;
  if (!immAssociateContext || !immAssociateContextEx || !immDisableIme)
    return process.platform !== "win32";
  try {
    // Every Electron BrowserWindow belongs to the main UI thread. Disable that
    // thread's TSF/IMM input path; HWND association alone did not stop Chromium
    // from receiving system composition on Windows 11.
    electronThreadImeDisabled ??= Boolean(immDisableIme(0));
    // Electron returns a Buffer containing the HWND value, not a pointer to the Buffer.
    const handle = koffi.decode(window.getNativeWindowHandle(), "void *");
    // Detach the top-level Chromium host first, then all child HWNDs. The
    // previous child-only call left an existing top-level composition alive.
    if (!enabled) immAssociateContext(handle, null);
    const flags = enabled ? 0x11 : 0x01;
    const applied = immAssociateContextEx(handle, null, flags);
    const disabled = process.platform !== "win32" || electronThreadImeDisabled;
    const result = Boolean(applied) && Boolean(disabled);
    if (!result && lastImeIsolationResult !== false) {
      console.warn("[ime] Windows system IME isolation failed", {
        threadDisabled: disabled,
        windowContextDetached: Boolean(applied),
        windowId: window.id,
      });
    }
    lastImeIsolationResult = result;
    return result;
  } catch (error) {
    if (lastImeIsolationResult !== false)
      console.warn("[ime] Windows system IME isolation failed", error);
    lastImeIsolationResult = false;
    return false;
  }
}

/** 隐身是窗口策略，不参与面板、回复条或截图工作流的状态机。 */
export function createWindowStealthController(host: WindowStealthControllerHost) {
  let enabled = false;

  function refresh(reason = "window-restore"): void {
    const window = host.getMainWindow();
    if (!enabled || !window || window.isDestroyed()) return;
    setWindowCaptureProtection(window, true);
    setNativeImeEnabled(window, false);
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
    // The embedded Rime editor owns all text input in this application. Stealth
    // changes capture policy only; leaving stealth must not re-enable Windows IME.
    setNativeImeEnabled(window, false);
    host.setReplyBarInputMethod?.(false);
    host.setReplyBarProtection(value);
    host.setImeCandidateProtection?.(value);
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

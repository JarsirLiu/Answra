import os from "node:os";
import { app, type BrowserWindow } from "electron";
import koffi from "koffi";
import {
  getWindowCaptureDiagnostics,
  isWindowCaptureProtectionSupported,
} from "./windowCaptureProtection";

export interface WindowStealthControllerHost {
  getMainWindow: () => BrowserWindow | undefined;
  applyWindowPolicies: (enabled: boolean) => boolean;
  refreshWindowPolicies: (reason: string) => boolean;
}

export type NativeImeIsolationResult = "applied" | "not-required" | "failed";

/** `ImmAssociateContextEx` flag that restores a window's default IME context. */
const IACE_DEFAULT = 0x0010;
/** `ImmAssociateContextEx` flag that targets the window's child HWNDs. */
const IACE_CHILDREN = 0x0001;
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
let lastImeIsolationResult: boolean | undefined;

function nativeWindowHandle(window: BrowserWindow): unknown {
  // Electron returns a Buffer containing the HWND value, not a pointer to the Buffer.
  return koffi.decode(window.getNativeWindowHandle(), "void *");
}

function reportImeIsolation(result: boolean, window: BrowserWindow, action: string): void {
  if (!result && lastImeIsolationResult !== false) {
    console.warn(`[ime] Windows system IME ${action} failed`, { windowId: window.id });
  }
  lastImeIsolationResult = result;
}

/**
 * Detaches the window from its platform IME context while stealth is on. This is
 * reversible through `restoreNativeIme`, unlike `ImmDisableIME`, which would also
 * kill system IME input for normal mode after the user leaves stealth.
 */
export function isolateNativeIme(window: BrowserWindow): NativeImeIsolationResult {
  if (window.isDestroyed()) return "failed";
  if (!immAssociateContext || !immAssociateContextEx)
    return process.platform !== "win32" ? "not-required" : "failed";
  try {
    const handle = nativeWindowHandle(window);
    immAssociateContext(handle, null);
    const applied = Boolean(immAssociateContextEx(handle, null, IACE_CHILDREN));
    reportImeIsolation(applied, window, "isolation");
    return applied ? "applied" : "failed";
  } catch (error) {
    if (lastImeIsolationResult !== false)
      console.warn("[ime] Windows system IME isolation failed", error);
    lastImeIsolationResult = false;
    return "failed";
  }
}

/** Re-associates the default IME context so normal mode can type with the system IME. */
export function restoreNativeIme(window: BrowserWindow): NativeImeIsolationResult {
  if (window.isDestroyed()) return "failed";
  if (!immAssociateContextEx) return process.platform !== "win32" ? "not-required" : "failed";
  try {
    const restored = Boolean(immAssociateContextEx(nativeWindowHandle(window), null, IACE_DEFAULT));
    reportImeIsolation(restored, window, "restore");
    return restored ? "applied" : "failed";
  } catch (error) {
    if (lastImeIsolationResult !== false)
      console.warn("[ime] Windows system IME restore failed", error);
    lastImeIsolationResult = false;
    return "failed";
  }
}

/** 隐身是窗口策略，不参与面板、回复条或截图工作流的状态机。 */
export function createWindowStealthController(host: WindowStealthControllerHost) {
  let enabled = false;

  function refresh(reason = "window-restore"): void {
    const window = host.getMainWindow();
    if (!enabled || !window || window.isDestroyed()) return;
    host.refreshWindowPolicies(reason);
    isolateNativeIme(window);
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
    const applied = host.applyWindowPolicies(value);
    // Stealth keeps text input on the embedded Rime path via a non-activating
    // window; normal mode must hand text input back to the system IME.
    if (value) {
      isolateNativeIme(window);
      window.blur();
    } else {
      restoreNativeIme(window);
    }
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

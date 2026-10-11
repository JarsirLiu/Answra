import os from "node:os";
import type { BrowserWindow } from "electron";

/** 避免 resize/show 生命周期重复刷屏；每个原生窗口只记录状态变化。 */
const lastReportedState = new WeakMap<object, boolean>();

/** 只封装 OS 窗口捕获排除能力；任务栏/Dock 隐藏由窗口策略单独负责。 */
export function isWindowCaptureProtectionSupported(
  platform: NodeJS.Platform = process.platform,
  release = os.release(),
): boolean {
  if (platform === "win32") {
    const build = Number(release.split(".")[2]);
    return Number.isFinite(build) && build >= 19041;
  }
  return platform === "darwin";
}

/** 应用 Electron 的系统捕获排除标志；异常时保留窗口可用并给出诊断。 */
export function setWindowCaptureProtection(window: BrowserWindow, enabled: boolean): boolean {
  const context = {
    enabled,
    windowId: window.id,
    nativeHandle: readNativeHandle(window),
    bounds: readBounds(window),
    visible: readVisibility(window),
    platform: process.platform,
    release: process.platform === "win32" ? os.release() : undefined,
  };
  try {
    window.setContentProtection(enabled);
    const reportedProtected = readContentProtection(window);
    const result = { ...context, reportedProtected };
    if (reportedProtected !== undefined && reportedProtected !== enabled) {
      console.warn("[window][capture-protection] reported state does not match request", result);
      return false;
    }
    // The getter confirms Chromium's window flag, not that every capture app honors it.
    const appliedState = reportedProtected ?? enabled;
    if (lastReportedState.get(window) !== appliedState) {
      console.info("[window][capture-protection] state changed", result);
      lastReportedState.set(window, appliedState);
    }
    return true;
  } catch (error) {
    console.warn("[window][capture-protection] request failed", { ...context, error });
    return false;
  }
}

/**
 * Read-only snapshot used by the capture workflow diagnostics. This deliberately
 * reports Electron's flag and native identity together; the latter is what lets
 * us detect a window replacement or a post-resize lifecycle regression.
 */
export function getWindowCaptureDiagnostics(window: BrowserWindow): {
  nativeHandle?: string;
  bounds?: Electron.Rectangle;
  visible?: boolean;
  reportedProtected?: boolean;
} {
  return {
    nativeHandle: readNativeHandle(window),
    bounds: readBounds(window),
    visible: readVisibility(window),
    reportedProtected: readContentProtection(window),
  };
}

function readNativeHandle(window: BrowserWindow): string | undefined {
  try {
    const handle = window.getNativeWindowHandle();
    if (handle.length >= 8) return `0x${handle.readBigUInt64LE(0).toString(16)}`;
    if (handle.length >= 4) return `0x${handle.readUInt32LE(0).toString(16)}`;
  } catch {
    // Keep protection application independent from optional diagnostic details.
  }
  return undefined;
}

function readBounds(window: BrowserWindow): Electron.Rectangle | undefined {
  try {
    return window.getBounds();
  } catch {
    return undefined;
  }
}

function readVisibility(window: BrowserWindow): boolean | undefined {
  try {
    return window.isVisible();
  } catch {
    return undefined;
  }
}

function readContentProtection(window: BrowserWindow): boolean | undefined {
  try {
    const candidate = window as BrowserWindow & { isContentProtected?: () => boolean };
    return typeof candidate.isContentProtected === "function"
      ? candidate.isContentProtected()
      : undefined;
  } catch {
    return undefined;
  }
}

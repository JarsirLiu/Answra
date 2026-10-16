import { BrowserWindow } from "electron";
import koffi from "koffi";

const getForegroundWindow =
  process.platform === "win32"
    ? koffi.load("user32.dll").func("void * __stdcall GetForegroundWindow()")
    : undefined;
const getWindowThreadProcessId =
  process.platform === "win32"
    ? koffi
        .load("user32.dll")
        .func("uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *lpdwProcessId)")
    : undefined;
const getClassName =
  process.platform === "win32"
    ? koffi
        .load("user32.dll")
        .func("int __stdcall GetClassNameW(void *hWnd, void *lpClassName, int nMaxCount)")
    : undefined;
const CLASS_NAME_BUFFER_BYTES = 512;
const CLASS_NAME_MAX_CHARS = CLASS_NAME_BUFFER_BYTES / 2;

/** Checks the foreground OS process, including when Electron has no focused BrowserWindow. */
export function isCurrentProcessForeground(): boolean {
  if (!getForegroundWindow || !getWindowThreadProcessId) {
    return BrowserWindow.getFocusedWindow() !== null;
  }
  const handle = getForegroundWindow();
  if (!handle) return false;
  const processId: [number] = [0];
  if (!getWindowThreadProcessId(handle, processId)) return false;
  return processId[0] === process.pid;
}

export interface ForegroundWindowInfo {
  pid?: number;
  className?: string;
  isOwnProcess?: boolean;
}

/** Best-effort identification of the OS foreground window, used by IME diagnostics. */
export function describeForegroundWindow(): ForegroundWindowInfo {
  if (!getForegroundWindow || !getWindowThreadProcessId) return {};
  try {
    const handle = getForegroundWindow();
    if (!handle) return { className: "<none>" };
    const processId: [number] = [0];
    getWindowThreadProcessId(handle, processId);
    let className: string | undefined;
    if (getClassName) {
      const buffer = Buffer.alloc(CLASS_NAME_BUFFER_BYTES);
      const length = getClassName(handle, buffer, CLASS_NAME_MAX_CHARS);
      // Decode with an explicit code-unit count. Decoding a JS buffer as `str16`
      // makes Koffi treat the buffer contents as a string pointer and dereference
      // it; the resulting access violation kills the main process outright
      // instead of raising a catchable error.
      if (length > 0) className = koffi.decode(buffer, "char16_t", length) as string;
    }
    return {
      pid: processId[0],
      className,
      isOwnProcess: processId[0] === process.pid,
    };
  } catch {
    return {};
  }
}

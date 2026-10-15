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

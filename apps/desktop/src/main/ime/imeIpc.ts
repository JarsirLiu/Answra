import { ImeChannels, type ImeKeyRequest } from "@answra/shared";
import { ipcMain } from "electron";
import { getReplyBarWindow, getWindow, isStealthEnabled, isWindowFromSender } from "../window";
import { setNativeImeEnabled } from "../windowStealthController";
import { RimeBridge } from "./rimeBridge";

export function registerImeIpc(): { dispose: () => void; available: boolean } {
  const bridge = new RimeBridge();
  const windowFor = (event: Electron.IpcMainInvokeEvent) => {
    const main = getWindow();
    if (main && isWindowFromSender(main, event)) return main;
    const reply = getReplyBarWindow();
    return reply && isWindowFromSender(reply, event) ? reply : undefined;
  };
  ipcMain.handle(ImeChannels.Enable, async (event, enabled: unknown) => {
    const window = windowFor(event);
    console.info("[ime] enable request", {
      enabled,
      windowId: window?.id,
      available: bridge.available,
      stealth: isStealthEnabled(),
    });
    if (!window || typeof enabled !== "boolean") return bridge.enable(false);
    if (enabled) {
      const nativeImeDisabled = setNativeImeEnabled(window, false);
      if (!nativeImeDisabled) {
        console.error("[ime] refusing input because system IME could not be disabled", {
          windowId: window.id,
          librimeAvailable: bridge.available,
          stealth: isStealthEnabled(),
        });
        return bridge.enable(false);
      }
      const state = await bridge.enable(true);
      console.info("[ime] enable result", {
        windowId: window.id,
        enabled: state.enabled,
        handled: state.handled,
      });
      // Fail closed: librime/helper failure must not reopen the system IME.
      return state;
    }
    setNativeImeEnabled(window, false);
    const state = await bridge.enable(enabled);
    console.info("[ime] disable result", { windowId: window.id, enabled: state.enabled });
    return state;
  });
  ipcMain.handle(ImeChannels.Key, (event, request: ImeKeyRequest) => {
    if (!windowFor(event) || !isKeyRequest(request)) return bridge.enable(false);
    return bridge.key(request);
  });
  ipcMain.handle(ImeChannels.Select, (event, request: { index?: unknown }) => {
    if (!windowFor(event) || !Number.isInteger(request?.index)) return bridge.enable(false);
    return bridge.select(request.index as number);
  });
  ipcMain.handle(ImeChannels.Reset, (event) => {
    if (!windowFor(event)) return bridge.enable(false);
    return bridge.reset();
  });
  return { available: bridge.available, dispose: () => bridge.dispose() };
}

function isKeyRequest(value: unknown): value is ImeKeyRequest {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    ["key", "code"].every((key) => typeof item[key] === "string") &&
    ["shift", "ctrl", "alt", "meta"].every((key) => typeof item[key] === "boolean")
  );
}

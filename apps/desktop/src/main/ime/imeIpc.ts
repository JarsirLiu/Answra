import { ImeChannels, type ImeKeyRequest, type ImeState } from "@answra/shared";
import { ipcMain } from "electron";
import { getReplyBarWindow, getWindow, isStealthEnabled, isWindowFromSender } from "../window";
import { setNativeImeEnabled } from "../windowStealthController";
import { RimeBridge } from "./rimeBridge";

const EMPTY_STATE: ImeState = {
  enabled: false,
  composing: false,
  preedit: "",
  candidates: [],
  selectedIndex: 0,
  page: 0,
  hasNextPage: false,
};

export function registerImeIpc(): { dispose: () => void; available: boolean } {
  const bridge = new RimeBridge();
  let sessionOwner: Electron.BrowserWindow | undefined;
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
    if (!window || typeof enabled !== "boolean") return { ...EMPTY_STATE };
    if (enabled) {
      sessionOwner = window;
      const nativeImeDisabled = setNativeImeEnabled(window, false);
      if (!nativeImeDisabled) {
        console.error("[ime] refusing input because system IME could not be disabled", {
          windowId: window.id,
          librimeAvailable: bridge.available,
          stealth: isStealthEnabled(),
        });
        sessionOwner = undefined;
        await bridge.enable(false);
        return { ...EMPTY_STATE };
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
    if (sessionOwner !== window) return { ...EMPTY_STATE };
    sessionOwner = undefined;
    setNativeImeEnabled(window, false);
    const state = await bridge.enable(enabled);
    console.info("[ime] disable result", { windowId: window.id, enabled: state.enabled });
    return state;
  });
  ipcMain.handle(ImeChannels.Key, async (event, request: ImeKeyRequest) => {
    const window = windowFor(event);
    if (!window || sessionOwner !== window || !isKeyRequest(request)) return { ...EMPTY_STATE };
    return bridge.key(request);
  });
  ipcMain.handle(ImeChannels.Select, (event, request: { index?: unknown }) => {
    const window = windowFor(event);
    if (
      !window ||
      sessionOwner !== window ||
      !Number.isInteger(request?.index) ||
      (request.index as number) < 0
    )
      return { ...EMPTY_STATE };
    return bridge.select(request.index as number);
  });
  ipcMain.handle(ImeChannels.Reset, (event) => {
    const window = windowFor(event);
    if (!window || sessionOwner !== window) return { ...EMPTY_STATE };
    return bridge.reset();
  });
  return {
    available: bridge.available,
    dispose: () => {
      sessionOwner = undefined;
      bridge.dispose();
    },
  };
}

function isKeyRequest(value: unknown): value is ImeKeyRequest {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    ["key", "code"].every((key) => typeof item[key] === "string") &&
    ["shift", "ctrl", "alt", "meta"].every((key) => typeof item[key] === "boolean")
  );
}

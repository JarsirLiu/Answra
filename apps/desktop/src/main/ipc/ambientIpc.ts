import { AmbientChannels } from "@answra/shared";
import { ipcMain } from "electron";
import { getWindow, isWindowFromSender } from "../window";

/** Renderer owns the persisted preference; main owns the native sampler lifecycle. */
export function registerAmbientIpc(setEnabled: (enabled: boolean) => void): void {
  ipcMain.on(AmbientChannels.SetFollow, (event, enabled: unknown) => {
    if (!isWindowFromSender(getWindow(), event) || typeof enabled !== "boolean") return;
    setEnabled(enabled);
  });
}

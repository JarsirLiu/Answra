import { app, BrowserWindow } from "electron";
import { startAmbientTheme } from "./ambient";
import { registerCaptureIpc } from "./capture/captureIpc";
import { registerWindowIpc } from "./ipc/windowIpc";
import { createMainWindow } from "./window";

app.whenReady().then(() => {
  registerWindowIpc();
  registerCaptureIpc();
  const window = createMainWindow();
  const stopAmbient = startAmbientTheme(window);
  window.on("closed", stopAmbient);
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on("window-all-closed", () => app.quit());

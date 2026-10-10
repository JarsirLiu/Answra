import { app, BrowserWindow } from "electron";
import { registerWindowIpc } from "./ipc/windowIpc";
import { createMainWindow } from "./window";

app.whenReady().then(() => {
  registerWindowIpc();
  createMainWindow();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on("window-all-closed", () => app.quit());

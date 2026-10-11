import { app, BrowserWindow } from "electron";
import { createAmbientThemeController } from "./ambient";
import { registerCaptureIpc } from "./capture/captureIpc";
import { configureChromiumCompatibility } from "./chromiumCompatibility";
import { registerAmbientIpc } from "./ipc/ambientIpc";
import { registerWindowIpc } from "./ipc/windowIpc";
import { createMainWindow } from "./window";

// 必须在 app ready 前配置，避免 Chromium 先按 HDR 10-bit 输出初始化采集链。
configureChromiumCompatibility({ app });

let ambientController: ReturnType<typeof createAmbientThemeController> | undefined;

app.whenReady().then(() => {
  registerWindowIpc();
  registerCaptureIpc();
  registerAmbientIpc((enabled) => ambientController?.setEnabled(enabled));
  createManagedMainWindow();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createManagedMainWindow();
});

app.on("window-all-closed", () => app.quit());

function createManagedMainWindow(): void {
  const window = createMainWindow();
  const controller = createAmbientThemeController(window);
  ambientController = controller;
  window.once("closed", () => {
    controller.dispose();
    if (ambientController === controller) ambientController = undefined;
  });
}

import { app, BrowserWindow } from "electron";
import { createAmbientThemeController } from "./ambient";
import { registerCaptureIpc } from "./capture/captureIpc";
import { configureChromiumCompatibility } from "./chromiumCompatibility";
import { AppService } from "./conversation/appService";
import { registerConversationIpc } from "./conversation/conversationIpc";
import { registerImeCandidateIpc } from "./ime/imeCandidateIpc";
import { registerImeIpc } from "./ime/imeIpc";
import { registerAmbientIpc } from "./ipc/ambientIpc";
import { registerWindowIpc } from "./ipc/windowIpc";
import { createMainWindow, disposeImeCandidateWindow, getWindow, isStealthEnabled } from "./window";
import {
  registerWorkspaceFileProtocol,
  registerWorkspaceSchemePrivileges,
} from "./workspace/fileProtocol";
import { registerWorkspaceIpc } from "./workspace/workspaceIpc";
import { WorkspaceService } from "./workspace/workspaceService";

// 必须在 app ready 前配置，避免 Chromium 先按 HDR 10-bit 输出初始化采集链。
configureChromiumCompatibility({ app });
// 自定义 scheme 权限同样必须在 ready 前声明。
registerWorkspaceSchemePrivileges();

let ambientController: ReturnType<typeof createAmbientThemeController> | undefined;
let imeController: ReturnType<typeof registerImeIpc> | undefined;
const appService = new AppService();
const workspaceService = new WorkspaceService({ configDir: app.getPath("userData") });

app.whenReady().then(() => {
  registerWindowIpc();
  imeController = registerImeIpc();
  registerImeCandidateIpc(imeController.isCurrentLease, imeController.getSessionSnapshot);
  registerCaptureIpc();
  registerAmbientIpc((enabled) => ambientController?.setEnabled(enabled));
  registerConversationIpc(appService);
  registerWorkspaceFileProtocol(workspaceService);
  registerWorkspaceIpc(workspaceService, getWindow, isStealthEnabled);
  void appService.start().catch((error) => console.error("[app-service] failed to start", error));
  void workspaceService
    .restoreRoot()
    .catch((error) => console.warn("[workspace] 根目录恢复失败", error));
  createManagedMainWindow();
});

app.on("before-quit", () => {
  disposeImeCandidateWindow();
  imeController?.dispose();
  void appService.stop();
  void workspaceService.dispose();
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

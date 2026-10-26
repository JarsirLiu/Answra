import { app, BrowserWindow, shell } from "electron";
import { createAmbientThemeController } from "./ambient";
import { registerAuthIpc } from "./auth/authIpc";
import { AuthService } from "./auth/authService";
import { deepLinkCallbackChannel, loopbackCallbackChannel } from "./auth/callbackChannel";
import { resolveCloudEndpoints } from "./auth/config";
import { FileAuthCredentialStore } from "./auth/credentialStore";
import { resolveDeviceDescriptor } from "./auth/deviceInfo";
import { registerAuthLifecycle } from "./auth/lifecycle";
import { FilePendingAuthStore } from "./auth/pendingAuthStore";
import { registerCaptureIpc } from "./capture/captureIpc";
import { configureChromiumCompatibility } from "./chromiumCompatibility";
import { AgentService } from "./conversation/agentService";
import { registerConversationIpc } from "./conversation/conversationIpc";
import { ModelRouter } from "./conversation/modelRouter";
import { ModelSettingsStore, modelSettingsFilePath } from "./conversation/modelSettings";
import { loadDevDotEnv } from "./devEnv";
import { registerImeCandidateIpc } from "./ime/imeCandidateIpc";
import { registerImeIpc } from "./ime/imeIpc";
import { registerInterviewIpc } from "./interview/interviewIpc";
import { registerAmbientIpc } from "./ipc/ambientIpc";
import { registerWindowIpc } from "./ipc/windowIpc";
import { createUpdateController } from "./updater/updateController";
import {
  createMainWindow,
  disposeImeCandidateWindow,
  getImeCandidateWindow,
  getWindow,
  isStealthEnabled,
  sendAuthStatus,
} from "./window";
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

// 打包版不读 .env；开发态在解析云端地址前注入仓库根 .env（不覆盖已有环境变量）。
if (!app.isPackaged) {
  const loaded = loadDevDotEnv(process.env, { cwd: process.cwd() });
  if (loaded.appliedKeys.length > 0) {
    console.log("[dev-env] applied keys:", loaded.appliedKeys.join(", "));
  }
}

let ambientController: ReturnType<typeof createAmbientThemeController> | undefined;
let imeController: ReturnType<typeof registerImeIpc> | undefined;
let interviewIpc: ReturnType<typeof registerInterviewIpc> | undefined;
let updateController: ReturnType<typeof createUpdateController> | undefined;
const configDir = app.getPath("userData");
const workspaceService = new WorkspaceService({ configDir });

const authService = new AuthService({
  endpoints: resolveCloudEndpoints(process.env, { isPackaged: app.isPackaged }),
  device: () => resolveDeviceDescriptor(configDir),
  credentials: new FileAuthCredentialStore(configDir),
  pendingStore: new FilePendingAuthStore(configDir),
  openExternal: (url) => shell.openExternal(url),
  // 打包版只认深链；开发态用环回回调，避免 dev 进程的协议注册体验问题。
  callbackChannel: app.isPackaged ? deepLinkCallbackChannel : loopbackCallbackChannel,
  onStatus: sendAuthStatus,
});

// 模型调用的端点与令牌都来自登录态：这里传惰性闭包，登录/刷新后自动生效，无需重启。
const modelSettings = new ModelSettingsStore(modelSettingsFilePath(configDir));
const modelRouter = new ModelRouter({
  store: modelSettings,
  localAvailable: !app.isPackaged,
  cloud: {
    modelConfig: () => authService.getDesktopModelConfig(),
    hasSession: () => authService.hasSession(),
    accessToken: (options) =>
      options?.forceRefresh ? authService.refreshAccessToken() : authService.getAccessToken(),
  },
});
const agentService = new AgentService({
  resolveModel: (options) => modelRouter.resolve(options),
  getWorkspaceRoot: () => workspaceService.getRoot(),
  log: (message, error) => console.warn(message, error),
});

// 授权回跳可能早于服务就绪（冷启动走深链）：先排队，等 restore 载入待处理登录后再消费。
const queuedAuthUrls: string[] = [];
let authReady = false;
function routeAuthCallback(url: string): void {
  if (authReady) {
    void authService.handleCallbackUrl(url);
    return;
  }
  queuedAuthUrls.push(url);
}
function flushAuthUrls(): void {
  authReady = true;
  for (const url of queuedAuthUrls.splice(0)) void authService.handleCallbackUrl(url);
}

// 单实例锁：第二个实例只负责把深链 argv 转发给已运行的实例。
// Windows 任务栏分组/通知按 AppUserModelID 识别，须与 electron-builder 的 appId 一致。
app.setAppUserModelId("dev.answra.desktop");
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerAuthLifecycle({
    onCallbackUrl: (url) => routeAuthCallback(url),
    onSecondInstance: () => getWindow()?.focus(),
  });

  app.whenReady().then(async () => {
    // 读盘依赖 safeStorage 就绪；放在注册会话 IPC 之前，避免首次拉取设置时回退到默认值。
    await modelSettings.init();
    registerWindowIpc();
    imeController = registerImeIpc();
    registerImeCandidateIpc(imeController.isCurrentLease, imeController.getSessionSnapshot);
    registerCaptureIpc();
    interviewIpc = registerInterviewIpc(agentService);
    registerAmbientIpc((enabled) => ambientController?.setEnabled(enabled));
    registerConversationIpc(agentService, {
      canSend: () => modelRouter.canSend(),
      modelSettings: modelRouter,
    });
    registerAuthIpc(authService);
    registerWorkspaceFileProtocol(workspaceService);
    registerWorkspaceIpc(workspaceService, getWindow, isStealthEnabled);
    void workspaceService
      .restoreRoot()
      .catch((error) => console.warn("[workspace] 根目录恢复失败", error))
      .finally(() => {
        void agentService
          .start()
          .catch((error) => console.error("[agent-service] failed to start", error));
      });
    createManagedMainWindow();
    updateController = createUpdateController({ isPackaged: app.isPackaged });
    void authService
      .restore()
      .catch((error) => console.warn("[auth] 登录态恢复失败", error))
      .finally(() => flushAuthUrls());
  });

  app.on("before-quit", () => {
    disposeImeCandidateWindow();
    imeController?.dispose();
    updateController?.dispose();
    authService.dispose();
    const interviewStop = interviewIpc?.stopActive() ?? Promise.resolve();
    interviewIpc?.dispose();
    void interviewStop.catch(() => undefined).finally(() => agentService.stop());
    void workspaceService.dispose();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createManagedMainWindow();
  });

  app.on("window-all-closed", () => app.quit());
}

function createManagedMainWindow(): void {
  const window = createMainWindow();
  interviewIpc?.bindWindow(window);
  const controller = createAmbientThemeController(window, {
    additionalTargets: () => [getImeCandidateWindow()],
  });
  ambientController = controller;
  window.once("closed", () => {
    controller.dispose();
    if (ambientController === controller) ambientController = undefined;
  });
}

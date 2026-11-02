import { join } from "node:path";
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
import { registerAmbientIpc } from "./ipc/ambientIpc";
import { registerWindowIpc } from "./ipc/windowIpc";
import { isMarkdownPath, openMarkdownDocument, registerMarkdownIpc } from "./markdown";
import { applyPendingUpdateOnLaunch } from "./updater/applyPendingUpdate";
import { createMacSwapInstaller } from "./updater/macUpdateSwap";
import { createUpdateController } from "./updater/updateController";
import { registerUpdateIpc } from "./updater/updateIpc";
import { createMainWindow, getWindow, sendAuthStatus } from "./window";
import { registerWorkspaceSchemePrivileges } from "./workspace/scheme";

// 必须在 app ready 前配置，避免 Chromium 先按 HDR 10-bit 输出初始化采集链。
configureChromiumCompatibility({ app });
// 自定义 scheme 权限同样必须在 ready 前声明。
if (__ANSWRA_FEATURE_WORKSPACE__) registerWorkspaceSchemePrivileges();

// 打包版不读 .env；开发态在解析云端地址前注入仓库根 .env（不覆盖已有环境变量）。
if (!app.isPackaged) {
  const loaded = loadDevDotEnv(process.env, { cwd: process.cwd() });
  if (loaded.appliedKeys.length > 0) {
    console.log("[dev-env] applied keys:", loaded.appliedKeys.join(", "));
  }
}

let ambientController: ReturnType<typeof createAmbientThemeController> | undefined;
let stopInterview: () => Promise<void> = async () => undefined;
let disposeInterview: () => void = () => undefined;
let bindInterviewWindow: (window: BrowserWindow) => void = () => undefined;
let getWorkspaceRoot: () => string | null = () => null;
let disposeWorkspace: (() => void) | undefined;
let updateController: ReturnType<typeof createUpdateController> | undefined;
let disposeUpdateIpc: (() => void) | undefined;
const configDir = app.getPath("userData");

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
  getWorkspaceRoot: () => getWorkspaceRoot(),
  log: (message, error) => console.warn(message, error),
});

// 授权回跳可能早于服务就绪（冷启动走深链）：先排队，等 restore 载入待处理登录后再消费。
const queuedAuthUrls: string[] = [];
const queuedMarkdownPaths: string[] = process.argv.filter(isMarkdownPath);
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
    onSecondInstance: (argv) => {
      const candidate = argv.find(isMarkdownPath);
      if (candidate) void openMarkdownDocument(candidate);
      else getWindow()?.focus();
    },
  });

  app.whenReady().then(async () => {
    // 上次下载好的更新在启动时安装：此时系统稳定，不会撞上“关闭后立刻关机”的窗口。
    if (
      app.isPackaged &&
      applyPendingUpdateOnLaunch({
        configDir,
        currentVersion: app.getVersion(),
        quit: () => app.quit(),
      })
    ) {
      return;
    }
    // 读盘依赖 safeStorage 就绪；放在注册会话 IPC 之前，避免首次拉取设置时回退到默认值。
    await modelSettings.init();
    registerWindowIpc();
    registerMarkdownIpc();
    registerCaptureIpc();
    if (__ANSWRA_FEATURE_INTERVIEW__) {
      const { registerInterviewIpc } = await import("./interview/interviewIpc");
      const interview = registerInterviewIpc(agentService);
      stopInterview = () => interview.stopActive();
      disposeInterview = () => interview.dispose();
      bindInterviewWindow = (window) => interview.bindWindow(window);
    }
    registerAmbientIpc((enabled) => ambientController?.setEnabled(enabled));
    registerConversationIpc(agentService, {
      canSend: () => modelRouter.canSend(),
      modelSettings: modelRouter,
    });
    registerAuthIpc(authService);
    const startAgent = () => {
      void agentService
        .start()
        .catch((error) => console.error("[agent-service] failed to start", error));
    };
    if (__ANSWRA_FEATURE_WORKSPACE__) {
      const { createWorkspaceComposition } = await import("./workspace/composition");
      const workspace = createWorkspaceComposition(configDir);
      getWorkspaceRoot = workspace.getRoot;
      disposeWorkspace = workspace.dispose;
      void workspace
        .restoreRoot()
        .catch((error) => console.warn("[workspace] 根目录恢复失败", error))
        .finally(startAgent);
    } else {
      startAgent();
    }
    updateController = createUpdateController({
      isPackaged: app.isPackaged,
      currentVersion: app.getVersion(),
      configDir,
      quit: () => app.quit(),
      ...(process.platform === "darwin"
        ? {
            macSwapInstaller: createMacSwapInstaller({
              execPath: process.execPath,
              swapDir: join(configDir, "mac-update"),
              scriptPath: join(configDir, "mac-update", "swap.sh"),
            }),
          }
        : {}),
    });
    disposeUpdateIpc = registerUpdateIpc(updateController);
    createManagedMainWindow();
    for (const filePath of queuedMarkdownPaths.splice(0)) void openMarkdownDocument(filePath);
    void authService
      .restore()
      .catch((error) => console.warn("[auth] 登录态恢复失败", error))
      .finally(() => flushAuthUrls());
  });

  app.on("before-quit", () => {
    disposeUpdateIpc?.();
    updateController?.dispose();
    authService.dispose();
    void stopInterview()
      .catch(() => undefined)
      .finally(() => agentService.stop());
    disposeInterview();
    disposeWorkspace?.();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createManagedMainWindow();
  });

  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    if (isMarkdownPath(filePath)) void openMarkdownDocument(filePath);
  });

  app.on("window-all-closed", () => app.quit());
}

function createManagedMainWindow(): void {
  const window = createMainWindow();
  bindInterviewWindow(window);
  const controller = createAmbientThemeController(window, {});
  ambientController = controller;
  window.once("closed", () => {
    controller.dispose();
    if (ambientController === controller) ambientController = undefined;
  });
}

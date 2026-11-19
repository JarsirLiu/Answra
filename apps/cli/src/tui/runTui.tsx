/** Ink TUI 运行器：挂载 App，驱动 CodingSession 的排队发送、等待与取消。 */
import type { ModelCredentialStore } from "@answra/credentials";
import type { ConversationModelConfig, ManualCompactionResult } from "@answra/shared";
import { render } from "ink";
import { createImageAttachmentReader } from "../adapters/imageAttachmentReader";
import type { ImageAttachment } from "../image/attachment";
import type { ImageAttachmentReader } from "../image/ports";
import type { ModelCatalog } from "../model/catalog";
import type { ModelSettings } from "../model/ports";
import type { RemoteAuthPort } from "../remote/auth/remoteAuthService";
import type { CodingSession } from "../session/codingSession";
import type { OpenBrowser } from "../transport/openBrowser";
import { App } from "./app/App";
import type { TuiViewStore } from "./app/viewStore";
import { dispatchTuiCommand } from "./commands/dispatch";
import { parseTuiCommand } from "./commands/parse";
import type { RemoteHostHandle, RemoteHostInfo, TuiCommandDeps } from "./commands/ports";
import { createClipboardWriter } from "./interaction/clipboard";
import { createPointerInput } from "./interaction/pointerInput";
import { createSelectionActions } from "./interaction/selectionActions";
import { TuiSelectionStore } from "./interaction/selectionStore";
import type { TuiSetupStep } from "./modelSetup";
import { createTuiPanelHandlers } from "./panelHandlers";
import type { TuiPanel } from "./panels/panel";
import { TuiRunController, type TuiSessionFactory } from "./runController";

export interface TuiRunOptions {
  session?: CodingSession;
  model?: string;
  createSession?: TuiSessionFactory;
  onInterrupt?: (handler: () => void) => () => void;
  store: TuiViewStore;
  modelSettings: ModelSettings;
  modelCredentials: ModelCredentialStore;
  modelCatalog: ModelCatalog;
  botName: string;
  workspaceRoot: string;
  altScreen: boolean;
  imageReader?: ImageAttachmentReader;
  remoteAuth?: RemoteAuthPort;
  openBrowser?: OpenBrowser;
  startRemoteHost?: () => Promise<RemoteHostHandle>;
}

export type TuiRunner = (options: TuiRunOptions) => Promise<number>;

export function createInkTuiRunner(): TuiRunner {
  return runInkTui;
}

export async function runInkTui({
  session: initialSession,
  model: initialModel,
  createSession,
  onInterrupt,
  store,
  modelSettings,
  modelCredentials,
  modelCatalog,
  botName,
  workspaceRoot,
  altScreen,
  imageReader: injectedImageReader,
  remoteAuth,
  openBrowser,
  startRemoteHost,
}: TuiRunOptions): Promise<number> {
  const imageReader = injectedImageReader ?? createImageAttachmentReader();
  let setupStep: TuiSetupStep | undefined = initialSession === undefined ? "base-url" : undefined;
  let setupBaseUrl = "";
  let setupApiKey = "";

  if (initialSession === undefined) {
    store.setModelConfigured(false);
    store.setSetupStep(setupStep);
  } else {
    store.initialize(await initialSession.open());
    store.setModelLabel(initialModel ?? "");
    store.setModelConfigured(true);
    store.setSetupStep(undefined);
  }

  store.setAuthAvailable(remoteAuth !== undefined);
  if (remoteAuth !== undefined) store.setAuthStatus(await remoteAuth.status());

  const resolveAccessToken = async (override?: string): Promise<string | undefined> => {
    if (override !== undefined && override !== "") return override;
    return (await modelCredentials.read()) ?? undefined;
  };
  const runController = new TuiRunController({ store, createSession, resolveAccessToken });
  if (initialSession !== undefined) runController.register(initialSession);

  let compactAbort: AbortController | undefined;
  let exitTui: (() => void) | undefined;
  let authCodeResolver: ((value: string) => void) | undefined;
  let activeRemoteHost: RemoteHostHandle | undefined;

  const submit = (text: string, images: readonly ImageAttachment[] = []): void => {
    if (authCodeResolver !== undefined) {
      const resolve = authCodeResolver;
      authCodeResolver = undefined;
      resolve(text);
      store.dismissNotification("login-code");
      return;
    }
    const invocation = parseTuiCommand(text);
    if (invocation) {
      void dispatchTuiCommand(invocation, commandDeps);
      return;
    }
    if (setupStep !== undefined) {
      void handleSetup(text);
      return;
    }
    runController.submit(text, images);
  };

  const login = async (): Promise<void> => {
    if (remoteAuth === undefined) return;
    store.notify({
      key: "login",
      text: "正在打开浏览器登录 Answra 账号……",
      tone: "info",
      priority: "high",
      timeoutMs: null,
    });
    try {
      const status = await remoteAuth.login({
        onAuthorizeUrl: async (url) => {
          if (openBrowser !== undefined) {
            try {
              await openBrowser(url);
              store.notify({
                key: "login",
                text: "浏览器已打开，请在 Answra 网站完成登录；完成后 CLI 会自动继续。",
                tone: "info",
                priority: "high",
                timeoutMs: null,
              });
            } catch {
              store.notify({
                key: "login",
                text: "无法自动打开浏览器，请检查系统默认浏览器后重新运行 /login。",
                tone: "warning",
                priority: "high",
              });
            }
          } else {
            store.notify({
              key: "login",
              text: "请在浏览器完成 Answra 登录；完成后 CLI 会自动继续。",
              tone: "info",
              priority: "high",
              timeoutMs: null,
            });
          }
        },
        promptCode: async (label) =>
          new Promise<string>((resolve) => {
            authCodeResolver = resolve;
            store.notify({
              key: "login-code",
              text: label,
              tone: "info",
              priority: "immediate",
              timeoutMs: null,
            });
          }),
      });
      store.setAuthStatus(status);
      store.notify({
        key: "login",
        text: `已登录 Answra 账号${status.account === null ? "。" : `：${status.account}。`}`,
        tone: "success",
        priority: "high",
      });
    } catch (error) {
      store.dismissNotification("login");
      throw error;
    } finally {
      authCodeResolver = undefined;
      store.dismissNotification("login-code");
    }
  };

  const ensureSession = async (
    model: ConversationModelConfig,
    accessToken?: string,
  ): Promise<void> => {
    if (runController.activeSession !== undefined) return;
    if (createSession === undefined) throw new Error("当前 TUI 未提供会话工厂。");
    const token = accessToken === undefined ? await resolveAccessToken() : accessToken;
    const next = createSession(model, token);
    const snapshot = await next.open();
    runController.register(next);
    store.initialize(snapshot);
    setupStep = undefined;
    store.setSetupStep(undefined);
    store.setModelConfigured(true);
  };

  /** 命令已通过 access；面板本身不再判断运行状态。 */
  const openPanel = (panel: TuiPanel): void => {
    store.setPanel(panel);
  };

  const runtime = () => runController.runtime();

  const compactConversation = async (instructions?: string): Promise<ManualCompactionResult> => {
    if (runtime().activeRunActive || store.getSnapshot().compactionActive) {
      throw new Error("上一轮尚未结束。");
    }
    const activeSession = runController.activeSession;
    if (activeSession === undefined) throw new Error("尚未配置模型。");
    const controller = new AbortController();
    compactAbort = controller;
    store.beginCompaction();
    try {
      const { result } = await activeSession.compact({
        signal: controller.signal,
        ...(instructions === undefined ? {} : { instructions }),
      });
      return result;
    } finally {
      if (compactAbort === controller) compactAbort = undefined;
      store.finishCompaction();
    }
  };

  const commandDeps: TuiCommandDeps = {
    store,
    modelSettings,
    runtime,
    getSession: () => runController.activeSession,
    activateSession: (conversationId) => runController.activate(conversationId),
    createNewSession: () => runController.createNew(),
    deleteSession: (conversationId) => runController.delete(conversationId),
    compactConversation,
    configureSession: ensureSession,
    requestExit: () => exitTui?.(),
    openPanel,
    remoteAuth,
    login,
    activeRemote: () => remoteInfo(activeRemoteHost),
    startRemoteHost: async () => {
      if (activeRemoteHost !== undefined) {
        throw new Error("远程连接已经开启；连接码只在创建时显示一次。");
      }
      if (startRemoteHost === undefined) throw new Error("当前环境未配置远程连接。");
      activeRemoteHost = await startRemoteHost();
      void activeRemoteHost.done.then(
        () => {
          if (activeRemoteHost !== undefined) {
            store.notify({ key: "remote", text: "远程 host 已停止。", tone: "info" });
          }
        },
        (error: unknown) => store.fail(messageOf(error)),
      );
      return activeRemoteHost;
    },
  };

  const panelHandlers = createTuiPanelHandlers({
    store,
    runController,
    modelSettings,
    modelCredentials,
    modelCatalog,
    ensureSession,
  });

  const handleSetup = async (text: string): Promise<void> => {
    if (setupStep === undefined) return;
    const value = text.trim();
    if (setupStep === "base-url") {
      if (value === "") return;
      setupBaseUrl = value;
      setupStep = "api-key";
      store.setSetupStep(setupStep);
      return;
    }
    if (setupStep === "api-key") {
      setupApiKey = value;
      setupStep = "model-id";
      store.setSetupStep(setupStep);
      return;
    }
    if (value === "") return;
    try {
      if (setupApiKey !== "") {
        try {
          await modelCredentials.write(setupApiKey);
        } catch (error) {
          store.fail(messageOf(error));
          return;
        }
      }
      const model = await modelSettings.addLocal({ baseUrl: setupBaseUrl, chatModel: value });
      const accessToken = setupApiKey !== "" ? setupApiKey : ((await resolveAccessToken()) ?? "");
      await ensureSession(model, accessToken);
      store.setModelLabel(model.chat.model);
      store.notify({
        key: "setup",
        text: [
          `模型已配置：${model.chat.model}`,
          setupApiKey !== ""
            ? "API Key 已保存到系统凭据库。"
            : "已使用系统凭据库中的 API Key（如已保存）。",
          "现在可以输入任务开始会话。",
        ].join("\n"),
        tone: "success",
      });
    } catch (error) {
      setupStep = "base-url";
      setupBaseUrl = "";
      setupApiKey = "";
      store.setSetupStep(setupStep);
      store.fail(messageOf(error));
    }
  };

  const cancel = (): void => {
    if (compactAbort !== undefined) {
      compactAbort.abort();
      return;
    }
    runController.cancel();
  };

  const removeInterrupt = onInterrupt?.(cancel);

  const registerExit = (exit: () => void): void => {
    exitTui = exit;
  };

  const selectionStore = altScreen ? new TuiSelectionStore() : undefined;
  const clipboard = createClipboardWriter(process.stdout);
  const selectionActions =
    selectionStore === undefined ? undefined : createSelectionActions(selectionStore, clipboard);
  const pointer = altScreen ? createPointerInput(process.stdin, process.stdout) : undefined;
  const unsubscribePointer = pointer?.source.subscribe((event) =>
    selectionActions?.handlePointer(event),
  );

  try {
    const instance = render(
      <App
        botName={botName}
        onCancel={cancel}
        onClearSelection={selectionActions?.clear}
        onCopySelection={selectionActions?.copy}
        onCopyText={clipboard.write}
        onExitReady={registerExit}
        onSelectAll={selectionActions?.selectAllAndCopy}
        onPasteError={(message) => store.notify({ key: "paste", text: message, tone: "error" })}
        onSubmit={submit}
        imageReader={imageReader}
        panelHandlers={panelHandlers}
        pointerSource={pointer?.source}
        selectionStore={selectionStore}
        store={store}
        workspaceRoot={workspaceRoot}
      />,
      {
        ...(pointer === undefined ? {} : { stdin: pointer.stdin }),
        alternateScreen: altScreen,
        exitOnCtrlC: false,
        incrementalRendering: true,
        kittyKeyboard: { mode: "auto", flags: ["disambiguateEscapeCodes"] },
        maxFps: 30,
        ...(selectionStore === undefined ? {} : { onRender: () => selectionStore.commitFrame() }),
      },
    );
    await instance.waitUntilExit();
  } finally {
    removeInterrupt?.();
    await activeRemoteHost?.stop();
    unsubscribePointer?.();
    pointer?.dispose();
  }
  return 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

function remoteInfo(host: RemoteHostHandle | undefined): RemoteHostInfo | undefined {
  if (host === undefined) return undefined;
  return host.code === undefined ? { keyId: host.keyId } : { code: host.code, keyId: host.keyId };
}

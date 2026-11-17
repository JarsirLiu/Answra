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
import { dispatchTuiCommand, type TuiCommandDeps } from "./commands/dispatch";
import { parseTuiCommand } from "./commands/parse";
import { createClipboardWriter } from "./interaction/clipboard";
import { createPointerInput } from "./interaction/pointerInput";
import { createSelectionActions } from "./interaction/selectionActions";
import { TuiSelectionStore } from "./interaction/selectionStore";
import type { TuiSetupStep } from "./modelSetup";
import type { TuiPanel, TuiPanelHandlers } from "./panel";

export type TuiSessionFactory = (
  model: ConversationModelConfig,
  accessToken?: string,
) => CodingSession;

export interface TuiRunOptions {
  session?: CodingSession;
  model?: string;
  createSession?: TuiSessionFactory;
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
  startRemoteHost?: () => Promise<{
    readonly code?: string;
    readonly keyId: string;
    readonly done: Promise<void>;
    stop(): Promise<void>;
  }>;
}

interface QueuedTurn {
  readonly text: string;
  readonly images: readonly ImageAttachment[];
}

export type TuiRunner = (options: TuiRunOptions) => Promise<number>;

export function createInkTuiRunner(): TuiRunner {
  return runInkTui;
}

export async function runInkTui({
  session: initialSession,
  model: initialModel,
  createSession,
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
  let session = initialSession;
  let setupStep: TuiSetupStep | undefined = session === undefined ? "base-url" : undefined;
  let setupBaseUrl = "";
  let setupApiKey = "";

  if (session === undefined) {
    store.setModelConfigured(false);
    store.setSetupStep(setupStep);
    store.setNotice(undefined);
  } else {
    store.initialize(await session.open());
    store.setModelLabel(initialModel ?? "");
    store.setModelConfigured(true);
    store.setSetupStep(undefined);
  }

  store.setAuthAvailable(remoteAuth !== undefined);
  if (remoteAuth !== undefined) store.setAuthStatus(await remoteAuth.status());

  const queue: QueuedTurn[] = [];
  let busy = false;
  let cancelRequested = false;
  let compactAbort: AbortController | undefined;
  let exitTui: (() => void) | undefined;
  let authCodeResolver: ((value: string) => void) | undefined;
  let activeRemoteHost:
    | Awaited<ReturnType<NonNullable<TuiRunOptions["startRemoteHost"]>>>
    | undefined;

  const submit = (text: string, images: readonly ImageAttachment[] = []): void => {
    if (authCodeResolver !== undefined) {
      const resolve = authCodeResolver;
      authCodeResolver = undefined;
      resolve(text);
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
    if (session === undefined) {
      store.setNotice(undefined);
      return;
    }
    if (text.trim().length === 0 && images.length === 0) return;
    queue.push({ text, images });
    store.setQueued(queue.length);
    void drain();
  };

  const login = async (): Promise<void> => {
    if (remoteAuth === undefined) return;
    if (busy) {
      store.setNotice(["当前运行中，先按 Esc 中断后再登录。"]);
      return;
    }
    store.setNotice(["正在打开浏览器登录 Answra 账号……"]);
    const status = await remoteAuth.login({
      onAuthorizeUrl: async (url) => {
        if (openBrowser !== undefined) {
          try {
            await openBrowser(url);
            store.setNotice(["浏览器已打开，请在 Answra 网站完成登录；完成后 CLI 会自动继续。"]);
          } catch {
            store.setNotice(["无法自动打开浏览器，请检查系统默认浏览器后重新运行 /login。"]);
          }
        } else {
          store.setNotice(["请在浏览器完成 Answra 登录；完成后 CLI 会自动继续。"]);
        }
      },
      promptCode: async (label) =>
        new Promise<string>((resolve) => {
          authCodeResolver = resolve;
          store.setNotice([label]);
        }),
    });
    store.setAuthStatus(status);
    store.setNotice(undefined);
  };

  const resolveAccessToken = async (override?: string): Promise<string | undefined> => {
    if (override !== undefined && override !== "") return override;
    return (await modelCredentials.read()) ?? undefined;
  };

  const ensureSession = async (
    model: ConversationModelConfig,
    accessToken?: string,
  ): Promise<void> => {
    if (session !== undefined) return;
    if (createSession === undefined) throw new Error("当前 TUI 未提供会话工厂。");
    const token = accessToken === undefined ? await resolveAccessToken() : accessToken;
    const next = createSession(model, token);
    store.initialize(await next.open());
    session = next;
    setupStep = undefined;
    store.setSetupStep(undefined);
    store.setModelConfigured(true);
  };

  const openPanel = (panel: TuiPanel): void => {
    if (busy) {
      store.setNotice(["当前运行中，先按 Esc 中断后再修改模型配置。"]);
      return;
    }
    store.setPanel(panel);
  };

  const compactConversation = async (instructions?: string): Promise<ManualCompactionResult> => {
    if (busy || store.getSnapshot().compactionActive) throw new Error("上一轮尚未结束。");
    const activeSession = session;
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
    isBusy: () => busy || store.getSnapshot().compactionActive,
    getSession: () => session,
    compactConversation,
    configureSession: ensureSession,
    requestExit: () => exitTui?.(),
    openPanel,
    remoteAuth,
    login,
    startRemoteHost: async () => {
      if (activeRemoteHost !== undefined) {
        throw new Error("远程连接已经开启；连接码只在创建时显示一次。");
      }
      if (startRemoteHost === undefined) throw new Error("当前环境未配置远程连接。");
      activeRemoteHost = await startRemoteHost();
      void activeRemoteHost.done.then(
        () => {
          if (activeRemoteHost !== undefined) store.setNotice(["远程 host 已停止。"]);
        },
        (error: unknown) => store.fail(messageOf(error)),
      );
      return activeRemoteHost;
    },
  };

  const panelHandlers: TuiPanelHandlers = {
    loadConfig: async () => {
      const snapshot = await modelSettings.snapshot();
      const apiKey = await modelCredentials.read();
      return {
        baseUrl: snapshot.local.baseUrl,
        chatModel: snapshot.local.chatModel,
        ...(snapshot.local.answerModel === undefined
          ? {}
          : { answerModel: snapshot.local.answerModel }),
        apiKey: apiKey ?? "",
      };
    },
    saveConfig: async (input) => {
      const before = await modelSettings.snapshot();
      const model = await modelSettings.addLocal({
        baseUrl: input.baseUrl,
        chatModel: input.chatModel,
        ...(input.answerModel === undefined ? {} : { answerModel: input.answerModel }),
      });
      let accessToken: string;
      if (input.apiKey.kind === "set") {
        await modelCredentials.write(input.apiKey.value);
        accessToken = input.apiKey.value;
      } else if (input.apiKey.kind === "clear") {
        await modelCredentials.clear();
        accessToken = "";
      } else {
        accessToken = (await modelCredentials.read()) ?? "";
      }
      if (session === undefined) {
        await ensureSession(model, accessToken);
      } else {
        session.setModel(model);
        session.setAccessToken(accessToken);
      }
      store.clearError();
      store.setModelLabel(model.chat.model);
      store.setModelConfigured(true);
      store.setSetupStep(undefined);
      const changes: string[] = [];
      if (before.local.baseUrl !== input.baseUrl) {
        changes.push(`Set baseUrl to ${input.baseUrl}`);
      }
      if (before.local.chatModel !== input.chatModel) {
        changes.push(`Set chatModel to ${input.chatModel}`);
      }
      if ((before.local.answerModel ?? "") !== (input.answerModel ?? "")) {
        changes.push(`Set answerModel to ${input.answerModel ?? "(none)"}`);
      }
      if (input.apiKey.kind === "set") changes.push("Set API key");
      else if (input.apiKey.kind === "clear") changes.push("Cleared API key");
      store.setNotice(changes.length === 0 ? ["Config dialog dismissed"] : changes);
    },
    loadModels: async () => {
      const snapshot = await modelSettings.snapshot();
      const current = snapshot.local.chatModel;
      if (!snapshot.configured || snapshot.local.baseUrl.trim() === "") {
        return {
          current,
          models: [],
          error: "尚未配置本地模型，请先打开 /config。",
        };
      }
      try {
        const apiKey = (await modelCredentials.read()) ?? undefined;
        const models = await modelCatalog.list({
          baseUrl: snapshot.local.baseUrl,
          ...(apiKey === undefined ? {} : { apiKey }),
        });
        return { current, models };
      } catch (error) {
        return { current, models: [], error: messageOf(error) };
      }
    },
    selectModel: async (modelId) => {
      if (busy) throw new Error("当前运行中，先按 Esc 中断后再切换模型。");
      const model = await modelSettings.switchChatModel(modelId);
      if (session === undefined) {
        await ensureSession(model);
      } else {
        session.setModel(model);
      }
      store.clearError();
      store.setModelLabel(model.chat.model);
      store.setModelConfigured(true);
      store.setSetupStep(undefined);
      store.setNotice([`已切换模型：${model.chat.model}`]);
    },
    loadSessions: async () => {
      const activeSession = session;
      if (activeSession === undefined) {
        return { current: "", sessions: [], error: "尚未配置模型，无法读取会话历史。" };
      }
      try {
        const sessions = await activeSession.listSessions();
        return { current: activeSession.currentConversationId, sessions };
      } catch (error) {
        return { current: activeSession.currentConversationId, sessions: [], error: messageOf(error) };
      }
    },
    resumeSession: async (conversationId) => {
      if (busy) throw new Error("当前运行中，先按 Esc 中断后再恢复会话。");
      const activeSession = session;
      if (activeSession === undefined) throw new Error("尚未配置模型。");
      if (conversationId === activeSession.currentConversationId) return;
      store.reset(await activeSession.resume(conversationId));
      store.setNotice([`已恢复会话：${conversationId}`]);
    },
    close: (reason) => {
      const panel = store.getSnapshot().panel;
      store.setPanel(undefined);
      if (
        reason === "dismissed" &&
        (panel === undefined || panel === "config" || panel === "model")
      ) {
        store.setNotice(["Config dialog dismissed"]);
      }
    },
  };

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
      store.setNotice([
        `模型已配置：${model.chat.model}`,
        setupApiKey !== ""
          ? "API Key 已保存到系统凭据库。"
          : "已使用系统凭据库中的 API Key（如已保存）。",
        "现在可以输入任务开始会话。",
      ]);
    } catch (error) {
      setupStep = "base-url";
      setupBaseUrl = "";
      setupApiKey = "";
      store.setSetupStep(setupStep);
      store.fail(messageOf(error));
      store.setNotice(undefined);
    }
  };

  const drain = async (): Promise<void> => {
    if (busy) return;
    const turn = queue.shift();
    store.setQueued(queue.length);
    if (turn === undefined) return;
    const activeSession = session;
    if (activeSession === undefined) {
      store.setNotice(undefined);
      return;
    }
    busy = true;
    cancelRequested = false;
    store.beginRun();
    let failed = false;
    try {
      const runId = await activeSession.send(turn.text, turn.images);
      if (cancelRequested) activeSession.cancel();
      await activeSession.wait(runId);
    } catch (error) {
      failed = true;
      queue.length = 0;
      store.setQueued(0);
      store.fail(messageOf(error));
    } finally {
      busy = false;
      cancelRequested = false;
    }
    if (failed || queue.length === 0) {
      store.finishRun();
      return;
    }
    void drain();
  };

  const cancel = (): void => {
    if (compactAbort !== undefined) {
      compactAbort.abort();
      return;
    }
    if (!busy) return;
    cancelRequested = true;
    queue.length = 0;
    store.setQueued(0);
    store.markCancelling();
    session?.cancel();
  };

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
        onPasteError={(message) => store.setNotice([message])}
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
    await activeRemoteHost?.stop();
    unsubscribePointer?.();
    pointer?.dispose();
  }
  return 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

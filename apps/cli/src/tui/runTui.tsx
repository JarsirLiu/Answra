/** Ink TUI 运行器：挂载 App，驱动 CodingSession 的排队发送、等待与取消。 */
import type { ModelCredentialStore } from "@answra/credentials";
import type { ConversationModelConfig } from "@answra/shared";
import { render } from "ink";
import type { ModelSettings } from "../model/ports";
import type { CodingSession } from "../session/codingSession";
import { App } from "./app/App";
import type { TuiViewStore } from "./app/viewStore";
import { dispatchTuiCommand, type TuiCommandDeps } from "./commands/dispatch";
import { parseTuiCommand } from "./commands/parse";
import { createClipboardWriter } from "./interaction/clipboard";
import { createPointerInput } from "./interaction/pointerInput";
import { createSelectionActions } from "./interaction/selectionActions";
import { TuiSelectionStore } from "./interaction/selectionStore";
import type { TuiSetupStep } from "./modelSetup";

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
  botName: string;
  workspaceRoot: string;
  altScreen: boolean;
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
  botName,
  workspaceRoot,
  altScreen,
}: TuiRunOptions): Promise<number> {
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

  const queue: string[] = [];
  let busy = false;
  let cancelRequested = false;
  let exitTui: (() => void) | undefined;

  const submit = (text: string): void => {
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
    queue.push(text);
    store.setQueued(queue.length);
    void drain();
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

  const commandDeps: TuiCommandDeps = {
    store,
    modelSettings,
    isBusy: () => busy,
    getSession: () => session,
    configureSession: ensureSession,
    requestExit: () => exitTui?.(),
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
    const text = queue.shift();
    store.setQueued(queue.length);
    if (text === undefined) return;
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
      const runId = await activeSession.send(text);
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
        onSubmit={submit}
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
    unsubscribePointer?.();
    pointer?.dispose();
  }
  return 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

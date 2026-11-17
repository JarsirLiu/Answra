import type { ModelCredentialStore } from "@answra/credentials";
import type { ConversationModelConfig, ConversationSnapshot } from "@answra/shared";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalog } from "../../src/model/catalog";
import type { ModelSettings } from "../../src/model/ports";
import type { RemoteAuthPort } from "../../src/remote/auth/remoteAuthService";
import type { CodingSession } from "../../src/session/codingSession";
import { TuiViewStore } from "../../src/tui/app/viewStore";
import { TUI_HELP_LINES } from "../../src/tui/commands/help";
import type { TuiPanelHandlers } from "../../src/tui/panel";
import { runInkTui } from "../../src/tui/runTui";

const { renderMock } = vi.hoisted(() => ({ renderMock: vi.fn() }));

vi.mock("ink", () => ({
  Box: () => null,
  Text: () => null,
  render: renderMock,
  useApp: () => ({ exit: vi.fn() }),
  useInput: () => {},
  useWindowSize: () => ({ columns: 80, rows: 24 }),
}));

interface AppProps {
  onSubmit: (text: string, images?: readonly { name: string; dataUrl: string }[]) => void;
  onCancel: () => void;
  selectionStore?: unknown;
  onCopySelection?: () => void;
  onSelectAll?: () => void;
  onClearSelection?: () => void;
  panelHandlers: TuiPanelHandlers;
}

interface RenderResult {
  props: AppProps;
  options: Record<string, unknown>;
  finish: () => void;
}

const snapshot: ConversationSnapshot = {
  conversationId: "conversation-1",
  eventRevision: 0,
  messages: [],
};

function modelConfig(model: string): ConversationModelConfig {
  return {
    chat: { baseUrl: "http://127.0.0.1:1234/v1", model, auth: "local" },
    answer: { baseUrl: "http://127.0.0.1:1234/v1", model, auth: "local" },
  };
}

function createModelCredentials(initial: string | null = null): ModelCredentialStore & {
  current(): string | null;
} {
  let apiKey = initial;
  return {
    read: vi.fn(async () => apiKey),
    write: vi.fn(async (value: string) => {
      apiKey = value;
    }),
    clear: vi.fn(async () => {
      apiKey = null;
    }),
    current: () => apiKey,
  };
}

function createModelCatalog(
  models: readonly string[] = ["test-model", "next-model"],
): ModelCatalog {
  return { list: vi.fn(async () => models) };
}

function createRemoteAuth(signedIn = true): RemoteAuthPort {
  const status = {
    signedIn,
    expiresAt: null,
    account: signedIn ? "tester@example.com" : null,
  };
  return {
    login: vi.fn(async () => status),
    status: vi.fn(async () => status),
    logout: vi.fn(async () => ({ signedIn: false, expiresAt: null, account: null })),
    getAccessToken: vi.fn(async () => "access-token"),
  };
}

function createModelSettings(): ModelSettings {
  return {
    resolve: vi.fn(async () => modelConfig("test-model")),
    snapshot: vi.fn(async () => ({
      source: "local" as const,
      local: {
        baseUrl: "http://127.0.0.1:1234/v1",
        chatModel: "test-model",
      },
      configured: true,
    })),
    addLocal: vi.fn(async () => modelConfig("added-model")),
    switchChatModel: vi.fn(async (model) => modelConfig(model)),
    clearLocal: vi.fn(async () => {}),
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createSession() {
  const sent: string[] = [];
  const sentImages: Array<readonly { name: string; dataUrl: string }[]> = [];
  const waits: Array<() => void> = [];
  const session = {
    open: vi.fn(async () => snapshot),
    send: vi.fn(async (text: string, images: readonly { name: string; dataUrl: string }[] = []) => {
      sent.push(text);
      sentImages.push(images);
      return `run-${sent.length}`;
    }),
    wait: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          waits.push(resolve);
        }),
    ),
    cancel: vi.fn(),
    clear: vi.fn(async () => snapshot),
    compact: vi.fn(async () => ({ result: { status: "compacted" as const }, snapshot })),
    setModel: vi.fn(),
    setAccessToken: vi.fn(),
    close: vi.fn(),
  } as unknown as CodingSession;
  return { session, sent, sentImages, waits };
}

async function start(
  session: CodingSession,
  store: TuiViewStore,
  altScreen = false,
  modelSettings = createModelSettings(),
  modelCredentials = createModelCredentials(),
  modelCatalog = createModelCatalog(),
  startRemoteHost?: () => Promise<{
    code: string;
    keyId: string;
    done: Promise<void>;
    stop(): Promise<void>;
  }>,
  remoteAuth?: RemoteAuthPort,
): Promise<RenderResult> {
  let props: AppProps | undefined;
  let options: Record<string, unknown> | undefined;
  let finish: (() => void) | undefined;
  renderMock.mockImplementation(
    (element: ReactElement<AppProps>, renderOptions: Record<string, unknown>) => {
      props = element.props;
      options = renderOptions;
      return {
        waitUntilExit: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      };
    },
  );
  void runInkTui({
    session,
    store,
    modelSettings,
    modelCredentials,
    modelCatalog,
    botName: "coding.engineer",
    model: "test-model",
    workspaceRoot: "D:\\workspace",
    altScreen,
    startRemoteHost,
    remoteAuth,
  });
  await tick();
  if (!props || !options || !finish) throw new Error("TUI did not render");
  return { props, options, finish };
}

async function startUnconfigured(
  store: TuiViewStore,
  modelSettings: ModelSettings,
  createSession: (model: ConversationModelConfig, accessToken?: string) => CodingSession,
  modelCredentials = createModelCredentials(),
  modelCatalog = createModelCatalog(),
): Promise<RenderResult> {
  let props: AppProps | undefined;
  let options: Record<string, unknown> | undefined;
  let finish: (() => void) | undefined;
  renderMock.mockImplementation(
    (element: ReactElement<AppProps>, renderOptions: Record<string, unknown>) => {
      props = element.props;
      options = renderOptions;
      return {
        waitUntilExit: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      };
    },
  );
  void runInkTui({
    createSession,
    store,
    modelSettings,
    modelCredentials,
    modelCatalog,
    botName: "coding.engineer",
    workspaceRoot: "D:\\workspace",
    altScreen: false,
  });
  await tick();
  if (!props || !options || !finish) throw new Error("TUI did not render");
  return { props, options, finish };
}

describe("runInkTui", () => {
  beforeEach(() => {
    renderMock.mockReset();
  });

  it("queues prompts submitted while a run is active", async () => {
    const { session, sent, waits } = createSession();
    const store = new TuiViewStore();
    const { props, finish } = await start(session, store);

    props.onSubmit("first");
    await tick();
    expect(sent).toEqual(["first"]);
    expect(store.getSnapshot().phase).toBe("running");

    props.onSubmit("second");
    await tick();
    expect(sent).toEqual(["first"]);
    expect(store.getSnapshot()).toMatchObject({ queued: 1, phase: "running" });

    waits.shift()?.();
    await tick();
    await tick();
    expect(sent).toEqual(["first", "second"]);
    expect(store.getSnapshot().queued).toBe(0);

    waits.shift()?.();
    await tick();
    expect(store.getSnapshot().phase).toBe("idle");
    finish();
    store.dispose();
  });

  it("passes image attachments to the active session", async () => {
    const { session, sent, sentImages, waits } = createSession();
    const store = new TuiViewStore();
    const { props, finish } = await start(session, store);
    const image = { name: "capture.png", dataUrl: "data:image/png;base64,QUJD" };

    props.onSubmit("look", [image]);
    await tick();

    expect(sent).toEqual(["look"]);
    expect(sentImages[0]).toEqual([image]);

    waits.shift()?.();
    await tick();
    finish();
    store.dispose();
  });

  it("handles help and clear without sending a prompt", async () => {
    const { session } = createSession();
    const store = new TuiViewStore();
    const { props, finish } = await start(session, store);

    props.onSubmit("/help");
    await tick();
    expect(store.getSnapshot().notice).toEqual(TUI_HELP_LINES);

    props.onSubmit("/clear");
    await tick();
    expect(session.clear).toHaveBeenCalledTimes(1);
    expect(session.send).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toMatchObject({
      notice: ["会话已清除。"],
      view: { eventRevision: 0, messages: [] },
    });

    finish();
    store.dispose();
  });

  it("starts a persistent remote host from /remote and stops it when the TUI exits", async () => {
    const { session } = createSession();
    const store = new TuiViewStore();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const stop = vi.fn(async () => {
      resolveDone();
    });
    const startRemoteHost = vi.fn(async () => ({
      code: "answra1.room.key.secret",
      keyId: "key-id",
      done,
      stop,
    }));
    const { props, finish } = await start(
      session,
      store,
      false,
      createModelSettings(),
      createModelCredentials(),
      createModelCatalog(),
      startRemoteHost,
      createRemoteAuth(),
    );

    props.onSubmit("/remote");
    await tick();

    expect(startRemoteHost).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().notice).toEqual([
      "远程连接已开启。请在其他设备运行 answra remote attach，并输入下面的连接码：",
      "answra1.room.key.secret",
      "Key ID: key-id",
      "连接码会持久保存，直到在 host 上撤销。",
      "撤销命令：answra remote key revoke key-id",
    ]);

    finish();
    await tick();
    expect(stop).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it("opens the sessions panel from /sessions and resumes the picked session", async () => {
    const { session } = createSession();
    Object.assign(session, {
      currentConversationId: "conversation-1",
      listSessions: vi.fn(async () => [
        {
          conversationId: "conversation-1",
          title: "当前会话",
          updatedAt: "2026-11-17T09:28:00.000Z",
        },
        {
          conversationId: "conversation-2",
          title: "旧会话",
          updatedAt: "2026-11-16T08:00:00.000Z",
        },
      ]),
      resume: vi.fn(async () => snapshot),
    });
    const store = new TuiViewStore();
    const { props, finish } = await start(session, store);

    props.onSubmit("/sessions");
    await tick();

    expect(store.getSnapshot().panel).toBe("sessions");
    expect(store.getSnapshot().notice).toBeUndefined();

    await props.panelHandlers.loadSessions().then((data) => {
      expect(data.current).toBe("conversation-1");
      expect(data.sessions).toHaveLength(2);
    });

    await props.panelHandlers.resumeSession("conversation-2");
    expect(session.resume).toHaveBeenCalledWith("conversation-2");
    expect(store.getSnapshot().notice).toEqual(["已恢复会话：conversation-2"]);

    finish();
    store.dispose();
  });

  it("refuses to resume a session while a run is active", async () => {
    const { session } = createSession();
    Object.assign(session, { currentConversationId: "conversation-1", resume: vi.fn() });
    const store = new TuiViewStore();
    const { props, finish } = await start(session, store);

    props.onSubmit("first");
    await tick();

    await expect(props.panelHandlers.resumeSession("conversation-2")).rejects.toThrow(
      "当前运行中，先按 Esc 中断后再恢复会话。",
    );
    expect(session.resume).not.toHaveBeenCalled();

    finish();
    store.dispose();
  });

  it("reports session list failures inside the panel data", async () => {
    const { session } = createSession();
    Object.assign(session, {
      currentConversationId: "conversation-1",
      listSessions: vi.fn(async () => {
        throw new Error("当前宿主不支持会话历史。");
      }),
    });
    const store = new TuiViewStore();
    const { props, finish } = await start(session, store);

    const data = await props.panelHandlers.loadSessions();
    expect(data).toMatchObject({ current: "conversation-1", sessions: [] });
    expect(data.error).toBe("当前宿主不支持会话历史。");

    finish();
    store.dispose();
  });

  it("runs manual compaction without sending a prompt", async () => {
    const { session } = createSession();
    const store = new TuiViewStore();
    const { props, finish } = await start(session, store);

    props.onSubmit("/compact");
    await tick();
    await tick();

    expect(session.compact).toHaveBeenCalledTimes(1);
    expect(session.compact).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(session.send).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toMatchObject({ compactionActive: false, phase: "idle" });

    finish();
    store.dispose();
  });

  it("passes /compact arguments as one-shot summary instructions", async () => {
    const { session } = createSession();
    const store = new TuiViewStore();
    const { props, finish } = await start(session, store);

    props.onSubmit("/compact 重点保留数据库迁移决定");
    await tick();
    await tick();

    expect(session.compact).toHaveBeenCalledWith(
      expect.objectContaining({
        instructions: "重点保留数据库迁移决定",
      }),
    );
    expect(session.send).not.toHaveBeenCalled();

    finish();
    store.dispose();
  });

  it("reports unknown commands without sending a prompt", async () => {
    const { session } = createSession();
    const store = new TuiViewStore();
    const { props, finish } = await start(session, store);

    props.onSubmit("/missing");
    await tick();

    expect(session.send).not.toHaveBeenCalled();
    expect(store.getSnapshot().notice).toEqual(["未知命令：/missing", "输入 /help 查看可用命令。"]);

    finish();
    store.dispose();
  });

  it("rejects clear while a run is active", async () => {
    const { session } = createSession();
    const store = new TuiViewStore();
    const { props, finish } = await start(session, store);

    props.onSubmit("first");
    await tick();
    props.onSubmit("/clear");
    await tick();

    expect(session.clear).not.toHaveBeenCalled();
    expect(store.getSnapshot().notice).toEqual(["当前运行中，先按 Esc 中断后再清除会话。"]);

    finish();
    store.dispose();
  });

  it("wires selection frame commits when the alternate screen is enabled", async () => {
    const { session } = createSession();
    const store = new TuiViewStore();
    const { props, options, finish } = await start(session, store, true);

    expect(options.alternateScreen).toBe(true);
    expect(typeof options.onRender).toBe("function");
    expect(props.selectionStore).toBeDefined();
    expect(props.onCopySelection).toBeTypeOf("function");
    expect(props.onSelectAll).toBeTypeOf("function");
    expect(props.onClearSelection).toBeTypeOf("function");
    const onRender = options.onRender as (metrics: { renderTime: number }) => void;
    expect(() => onRender({ renderTime: 1 })).not.toThrow();

    finish();
    store.dispose();
  });

  it("keeps terminal-native selection and copy outside the alternate screen", async () => {
    const { session } = createSession();
    const store = new TuiViewStore();
    const { props, options, finish } = await start(session, store);

    expect(options.alternateScreen).toBe(false);
    expect(options.onRender).toBeUndefined();
    expect(props.selectionStore).toBeUndefined();
    expect(props.onCopySelection).toBeUndefined();
    expect(props.onSelectAll).toBeUndefined();
    expect(props.onClearSelection).toBeUndefined();

    finish();
    store.dispose();
  });

  it("clears queued prompts when the active run is cancelled", async () => {
    const { session, waits } = createSession();
    const store = new TuiViewStore();
    const { props, finish } = await start(session, store);

    props.onSubmit("first");
    await tick();
    props.onSubmit("second");
    await tick();
    props.onCancel();

    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({ queued: 0, phase: "cancelling" });

    waits.shift()?.();
    await tick();
    await tick();
    expect(session.send).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().phase).toBe("idle");
    finish();
    store.dispose();
  });

  it("opens the model picker and switches a model while idle", async () => {
    const { session } = createSession();
    const store = new TuiViewStore();
    const modelSettings = createModelSettings();
    const { props, finish } = await start(session, store, false, modelSettings);

    props.onSubmit("/model");
    await tick();
    expect(store.getSnapshot().panel).toBe("model");

    props.panelHandlers.close();
    props.onSubmit("/model next-model");
    await tick();
    expect(modelSettings.switchChatModel).toHaveBeenCalledWith("next-model");
    expect(session.setModel).toHaveBeenCalledWith(modelConfig("next-model"));
    expect(store.getSnapshot()).toMatchObject({
      modelLabel: "next-model",
      notice: ["已切换模型：next-model"],
    });

    finish();
    store.dispose();
  });

  it("redirects /model add to /config", async () => {
    const { session } = createSession();
    const store = new TuiViewStore();
    const modelSettings = createModelSettings();
    const { props, finish } = await start(session, store, false, modelSettings);

    props.onSubmit("/model add http://127.0.0.1:9999/v1 added-model added-answer");
    await tick();

    expect(modelSettings.addLocal).not.toHaveBeenCalled();
    expect(store.getSnapshot().localError).toBe("已改用 /config 修改完整模型配置。");

    finish();
    store.dispose();
  });

  it("loads and saves model config with keychain updates", async () => {
    const { session } = createSession();
    const store = new TuiViewStore();
    const modelSettings = createModelSettings();
    const modelCredentials = createModelCredentials("old-key");
    const { props, finish } = await start(session, store, false, modelSettings, modelCredentials);

    const data = await props.panelHandlers.loadConfig();
    expect(data).toMatchObject({
      baseUrl: "http://127.0.0.1:1234/v1",
      chatModel: "test-model",
      apiKey: "old-key",
    });

    await props.panelHandlers.saveConfig({
      baseUrl: "http://127.0.0.1:9999/v1",
      chatModel: "saved-model",
      apiKey: { kind: "set", value: "new-key" },
    });

    expect(modelSettings.addLocal).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:9999/v1",
      chatModel: "saved-model",
    });
    expect(modelCredentials.write).toHaveBeenCalledWith("new-key");
    expect(session.setModel).toHaveBeenCalledWith(modelConfig("added-model"));
    expect(session.setAccessToken).toHaveBeenCalledWith("new-key");
    expect(store.getSnapshot()).toMatchObject({
      modelLabel: "added-model",
      notice: [
        "Set baseUrl to http://127.0.0.1:9999/v1",
        "Set chatModel to saved-model",
        "Set API key",
      ],
    });

    finish();
    store.dispose();
  });

  it("does not rewrite an unchanged API key when saving other fields", async () => {
    const { session } = createSession();
    const store = new TuiViewStore();
    const modelSettings = createModelSettings();
    const modelCredentials = createModelCredentials("stored-key");
    const { props, finish } = await start(session, store, false, modelSettings, modelCredentials);

    const data = await props.panelHandlers.loadConfig();
    expect(data.apiKey).toBe("stored-key");

    await props.panelHandlers.saveConfig({
      baseUrl: "http://127.0.0.1:9999/v1",
      chatModel: "saved-model",
      apiKey: { kind: "keep" },
    });

    expect(modelCredentials.write).not.toHaveBeenCalled();
    expect(modelCredentials.clear).not.toHaveBeenCalled();
    expect(session.setAccessToken).toHaveBeenCalledWith("stored-key");
    expect(store.getSnapshot().notice).toEqual([
      "Set baseUrl to http://127.0.0.1:9999/v1",
      "Set chatModel to saved-model",
    ]);

    finish();
    store.dispose();
  });

  it("dismisses an unchanged config with the Claude Code message", async () => {
    const { session } = createSession();
    const store = new TuiViewStore();
    const modelSettings = createModelSettings();
    const { props, finish } = await start(session, store, false, modelSettings);

    await props.panelHandlers.saveConfig({
      baseUrl: "http://127.0.0.1:1234/v1",
      chatModel: "test-model",
      apiKey: { kind: "keep" },
    });

    expect(store.getSnapshot().notice).toEqual(["Config dialog dismissed"]);

    finish();
    store.dispose();
  });

  it("reports dismissal when the config panel closes without saving", async () => {
    const { session } = createSession();
    const store = new TuiViewStore();
    const { props, finish } = await start(session, store);

    props.panelHandlers.close("dismissed");

    expect(store.getSnapshot().panel).toBeUndefined();
    expect(store.getSnapshot().notice).toEqual(["Config dialog dismissed"]);

    finish();
    store.dispose();
  });

  it("loads models and applies a selection", async () => {
    const { session } = createSession();
    const store = new TuiViewStore();
    const modelSettings = createModelSettings();
    const modelCatalog = createModelCatalog(["test-model", "other-model"]);
    const { props, finish } = await start(
      session,
      store,
      false,
      modelSettings,
      createModelCredentials(),
      modelCatalog,
    );

    await expect(props.panelHandlers.loadModels()).resolves.toEqual({
      current: "test-model",
      models: ["test-model", "other-model"],
    });
    await props.panelHandlers.selectModel("other-model");
    expect(modelSettings.switchChatModel).toHaveBeenCalledWith("other-model");
    expect(session.setModel).toHaveBeenCalledWith(modelConfig("other-model"));
    expect(store.getSnapshot().modelLabel).toBe("other-model");

    finish();
    store.dispose();
  });

  it("keeps the current model when the catalog fails", async () => {
    const { session } = createSession();
    const store = new TuiViewStore();
    const modelSettings = createModelSettings();
    const modelCatalog: ModelCatalog = {
      list: vi.fn(async () => {
        throw new Error("HTTP 404");
      }),
    };
    const { props, finish } = await start(
      session,
      store,
      false,
      modelSettings,
      createModelCredentials(),
      modelCatalog,
    );

    await expect(props.panelHandlers.loadModels()).resolves.toEqual({
      current: "test-model",
      models: [],
      error: "HTTP 404",
    });

    finish();
    store.dispose();
  });

  it("refuses to open a panel while a run is active", async () => {
    const { session } = createSession();
    const store = new TuiViewStore();
    const { props, finish } = await start(session, store);

    props.onSubmit("first");
    await tick();
    props.onSubmit("/config");
    await tick();

    expect(store.getSnapshot().panel).toBeUndefined();
    expect(store.getSnapshot().notice).toEqual(["当前运行中，先按 Esc 中断后再修改模型配置。"]);

    finish();
    store.dispose();
  });

  it("walks through base URL, API key, and model ID before creating the session", async () => {
    const store = new TuiViewStore();
    const modelSettings = createModelSettings();
    const modelCredentials = createModelCredentials();
    const { session } = createSession();
    const create = vi.fn(() => session);
    const { props, finish } = await startUnconfigured(
      store,
      modelSettings,
      create,
      modelCredentials,
    );

    expect(store.getSnapshot()).toMatchObject({
      modelConfigured: false,
      setupStep: "base-url",
      notice: undefined,
    });

    props.onSubmit("http://127.0.0.1:9999/v1");
    await tick();
    expect(store.getSnapshot()).toMatchObject({
      setupStep: "api-key",
      notice: undefined,
    });

    props.onSubmit("sk-test");
    await tick();
    expect(store.getSnapshot()).toMatchObject({
      setupStep: "model-id",
      notice: undefined,
    });

    props.onSubmit("qwen");
    await tick();

    expect(modelSettings.addLocal).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:9999/v1",
      chatModel: "qwen",
    });
    expect(modelCredentials.write).toHaveBeenCalledWith("sk-test");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ chat: expect.objectContaining({ model: "added-model" }) }),
      "sk-test",
    );
    expect(session.open).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({
      modelConfigured: true,
      setupStep: undefined,
      modelLabel: "added-model",
      notice: [
        "模型已配置：added-model",
        "API Key 已保存到系统凭据库。",
        "现在可以输入任务开始会话。",
      ],
    });

    finish();
    store.dispose();
  });

  it("uses the saved keychain key when the API key step is empty", async () => {
    const store = new TuiViewStore();
    const modelSettings = createModelSettings();
    const modelCredentials = createModelCredentials("stored-key");
    const { session } = createSession();
    const create = vi.fn(() => session);
    const { props, finish } = await startUnconfigured(
      store,
      modelSettings,
      create,
      modelCredentials,
    );

    props.onSubmit("http://127.0.0.1:9999/v1");
    await tick();
    props.onSubmit("");
    await tick();
    props.onSubmit("qwen");
    await tick();

    expect(modelCredentials.write).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(expect.anything(), "stored-key");
    expect(store.getSnapshot()).toMatchObject({ modelConfigured: true, setupStep: undefined });

    finish();
    store.dispose();
  });

  it("opens /config and creates the session after saving when no model is configured", async () => {
    const store = new TuiViewStore();
    const modelSettings = createModelSettings();
    const { session } = createSession();
    const create = vi.fn(() => session);
    const { props, finish } = await startUnconfigured(store, modelSettings, create);

    props.onSubmit("/config");
    await tick();
    expect(store.getSnapshot().panel).toBe("config");

    await props.panelHandlers.saveConfig({
      baseUrl: "http://127.0.0.1:9999/v1",
      chatModel: "added-model",
      apiKey: { kind: "keep" },
    });

    expect(modelSettings.addLocal).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:9999/v1",
      chatModel: "added-model",
    });
    expect(create).toHaveBeenCalledWith(expect.anything(), "");
    expect(session.open).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({
      modelConfigured: true,
      setupStep: undefined,
      modelLabel: "added-model",
    });

    finish();
    store.dispose();
  });

  it("rejects model changes while a run is active", async () => {
    const { session } = createSession();
    const store = new TuiViewStore();
    const modelSettings = createModelSettings();
    const { props, finish } = await start(session, store, false, modelSettings);

    props.onSubmit("first");
    await tick();
    props.onSubmit("/model next-model");
    await tick();

    expect(modelSettings.switchChatModel).not.toHaveBeenCalled();
    expect(store.getSnapshot().localError).toBe("当前运行中，先按 Esc 中断后再切换模型。");

    finish();
    store.dispose();
  });
});

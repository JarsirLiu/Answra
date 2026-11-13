import type { ModelCredentialStore } from "@answra/credentials";
import type { ConversationModelConfig, ConversationSnapshot } from "@answra/shared";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelSettings } from "../src/model/ports";
import type { CodingSession } from "../src/session/codingSession";
import { TuiViewStore } from "../src/tui/app/viewStore";
import { TUI_HELP_LINES } from "../src/tui/commands/help";
import { runInkTui } from "../src/tui/runTui";

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
  onSubmit: (text: string) => void;
  onCancel: () => void;
  selectionStore?: unknown;
  onCopySelection?: () => void;
  onSelectAll?: () => void;
  onClearSelection?: () => void;
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
  const waits: Array<() => void> = [];
  const session = {
    open: vi.fn(async () => snapshot),
    send: vi.fn(async (text: string) => {
      sent.push(text);
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
    setModel: vi.fn(),
    close: vi.fn(),
  } as unknown as CodingSession;
  return { session, sent, waits };
}

async function start(
  session: CodingSession,
  store: TuiViewStore,
  altScreen = false,
  modelSettings = createModelSettings(),
  modelCredentials = createModelCredentials(),
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
    botName: "coding.engineer",
    model: "test-model",
    workspaceRoot: "D:\\workspace",
    altScreen,
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

  it("shows the current model and switches it while idle", async () => {
    const { session } = createSession();
    const store = new TuiViewStore();
    const modelSettings = createModelSettings();
    const { props, finish } = await start(session, store, false, modelSettings);

    props.onSubmit("/model");
    await tick();
    expect(store.getSnapshot().notice).toEqual([
      "source: local",
      "baseUrl: http://127.0.0.1:1234/v1",
      "chatModel: test-model",
      "answerModel: ",
      "configured: true",
    ]);

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

  it("adds a local model from /model add", async () => {
    const { session } = createSession();
    const store = new TuiViewStore();
    const modelSettings = createModelSettings();
    const { props, finish } = await start(session, store, false, modelSettings);

    props.onSubmit("/model add http://127.0.0.1:9999/v1 added-model added-answer");
    await tick();

    expect(modelSettings.addLocal).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:9999/v1",
      chatModel: "added-model",
      answerModel: "added-answer",
    });
    expect(store.getSnapshot().modelLabel).toBe("added-model");

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

  it("creates the session from /model add when no model is configured", async () => {
    const store = new TuiViewStore();
    const modelSettings = createModelSettings();
    const { session } = createSession();
    const create = vi.fn(() => session);
    const { props, finish } = await startUnconfigured(store, modelSettings, create);

    props.onSubmit("/model add http://127.0.0.1:9999/v1 added-model");
    await tick();

    expect(modelSettings.addLocal).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:9999/v1",
      chatModel: "added-model",
    });
    expect(create).toHaveBeenCalledWith(expect.anything(), undefined);
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

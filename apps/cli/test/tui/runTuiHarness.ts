import type { ModelCredentialStore } from "@answra/credentials";
import type { ConversationModelConfig, ConversationSnapshot } from "@answra/shared";
import type { ReactElement } from "react";
import { vi } from "vitest";
import type { ModelCatalog } from "../../src/model/catalog";
import type { ModelSettings } from "../../src/model/ports";
import type { RemoteAuthPort } from "../../src/remote/auth/remoteAuthService";
import type { CodingSession } from "../../src/session/codingSession";
import type { TuiViewStore } from "../../src/tui/app/viewStore";
import type { TuiPanelHandlers } from "../../src/tui/panels/panel";
import { runInkTui } from "../../src/tui/runTui";

const hoisted = vi.hoisted(() => ({ renderMock: vi.fn() }));
export const renderMock = hoisted.renderMock;

vi.mock("ink", () => ({
  Box: () => null,
  Text: () => null,
  render: hoisted.renderMock,
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

export const snapshot: ConversationSnapshot = {
  conversationId: "conversation-1",
  eventRevision: 0,
  messages: [],
};

export function modelConfig(model: string): ConversationModelConfig {
  return {
    chat: { baseUrl: "http://127.0.0.1:1234/v1", model, auth: "local" },
    answer: { baseUrl: "http://127.0.0.1:1234/v1", model, auth: "local" },
  };
}

export function createModelCredentials(initial: string | null = null): ModelCredentialStore & {
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

export function createModelCatalog(
  models: readonly string[] = ["test-model", "next-model"],
): ModelCatalog {
  return { list: vi.fn(async () => models) };
}

export function createRemoteAuth(signedIn = true): RemoteAuthPort {
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

export function createModelSettings(): ModelSettings {
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

export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function createSession(initialSnapshot: ConversationSnapshot = snapshot) {
  const sent: string[] = [];
  const sentImages: Array<readonly { name: string; dataUrl: string }[]> = [];
  const waits: Array<() => void> = [];
  const session = {
    currentConversationId: initialSnapshot.conversationId,
    modelConfig: modelConfig("test-model"),
    open: vi.fn(async () => initialSnapshot),
    refresh: vi.fn(async () => initialSnapshot),
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
    clear: vi.fn(async () => initialSnapshot),
    compact: vi.fn(async () => ({
      result: { status: "compacted" as const },
      snapshot: initialSnapshot,
    })),
    setModel: vi.fn(),
    setAccessToken: vi.fn(),
    close: vi.fn(),
  } as unknown as CodingSession;
  return { session, sent, sentImages, waits };
}

export async function start(
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
  createSession?: (
    model: ConversationModelConfig,
    accessToken?: string,
    conversationId?: string,
  ) => CodingSession,
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
    ...(createSession === undefined ? {} : { createSession }),
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

export async function startUnconfigured(
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

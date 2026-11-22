import type { ClientConfig } from "@answra/config";
import type { ModelCredentialStore } from "@answra/credentials";
import type {
  ConversationModelConfig,
  ConversationSendRequest,
  ConversationSnapshot,
} from "@answra/shared";
import { describe, expect, it, vi } from "vitest";
import type { CliDependencies } from "../../src/cli/dependencies";
import { CLI_HELP } from "../../src/cli/help";
import { runCli } from "../../src/cli/runCli";
import type { ModelSettingsStore } from "../../src/model/ports";
import { ModelSettingsService } from "../../src/model/settingsService";
import type { CodingSessionHost } from "../../src/session/codingSession";
import type { InputPort } from "../../src/transport/input";
import type { OutputPort } from "../../src/transport/output";
import { CLI_VERSION } from "../../src/version";
import { liveFrame, sessionFrame } from "../frameFixtures";

function createOutput(): OutputPort & { stdout: string; stderr: string } {
  const output = {
    stdout: "",
    stderr: "",
    write(chunk: string) {
      output.stdout += chunk;
    },
    writeError(chunk: string) {
      output.stderr += chunk;
    },
  };
  return output;
}

function createInput(value: string, isTTY = false): InputPort {
  return {
    isTTY,
    readAll: vi.fn(async () => value),
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

function createModelSettings(initial: ClientConfig | null = null): ModelSettingsService {
  let config = initial;
  const store: ModelSettingsStore = {
    read: vi.fn(async () => config),
    write: vi.fn(async (next) => {
      config = next;
    }),
  };
  return new ModelSettingsService(store);
}

const snapshot: ConversationSnapshot = {
  conversationId: "conversation-1",
  eventRevision: 0,
  lastSeq: 0,
  messages: [],
};

let sequence = 0;

function createDependencies(
  overrides: Partial<CliDependencies> & {
    sent?: ConversationSendRequest[];
    tokens?: string[];
  } = {},
): CliDependencies {
  const { sent: sentOverride, tokens: tokensOverride, ...depsOverrides } = overrides;
  const sent = sentOverride ?? [];
  const tokens = tokensOverride ?? [];
  const host: CodingSessionHost = {
    configure: vi.fn(),
    createConversation: vi.fn(async () => snapshot),
    clearConversation: vi.fn(async () => snapshot),
    send: vi.fn(async (_conversationId, request, token) => {
      sent.push(request);
      tokens.push(token);
      return { turnId: "turn-1" };
    }),
    enqueue: vi.fn(async (_conversationId, request, token) => {
      sent.push(request);
      tokens.push(token);
      return {
        queueId: "queue-1",
        status: "started" as const,
        position: 0 as const,
        turnId: "turn-1",
        snapshot,
      };
    }),
    waitForQueueStart: vi.fn(async (_conversationId, queueId) => ({
      queueId,
      turnId: "turn-1",
      snapshot,
    })),
    cancel: vi.fn(),
    waitForTurn: vi.fn(async () => {}),
    readFrames: vi.fn(async () => []),
    dispose: vi.fn(),
  };
  const dependencies: CliDependencies = {
    env: {
      ANSWRA_AI_BASE_URL: "http://127.0.0.1:1234/v1",
      ANSWRA_MODEL: "test-model",
      ANSWRA_API_KEY: "test-key",
    },
    input: createInput(""),
    output: createOutput(),
    cwd: process.cwd(),
    modelSettings: createModelSettings(),
    modelCredentials: createModelCredentials(),
    modelCatalog: { list: vi.fn(async () => []) },
    createSessionHost: vi.fn(({ onSessionFrame, onLiveFrame }) => {
      const send = host.send;
      host.send = vi.fn(async (conversationId, request, token) => {
        sequence += 1;
        onLiveFrame(
          liveFrame(
            { type: "text-delta", partId: "text-1", delta: "hi" },
            { messageId: "message-1" },
          ),
        );
        onSessionFrame(
          sessionFrame(
            sequence,
            { type: "text-end", partId: "text-1" },
            { turnId: "turn-1", messageId: "message-1" },
          ),
        );
        return send(conversationId, request, token);
      });
      return host;
    }),
    createConversationId: vi.fn(() => "conversation-1"),
    onInterrupt: vi.fn(() => vi.fn()),
    runTui: vi.fn(async () => 0),
    ...depsOverrides,
  };
  return dependencies;
}

describe("runCli", () => {
  it("prints help without resolving model configuration", async () => {
    const deps = createDependencies({ env: {} });
    await expect(runCli(["--help"], deps)).resolves.toBe(0);
    expect(deps.output).toMatchObject({ stdout: CLI_HELP });
  });

  it("prints the version", async () => {
    const deps = createDependencies({ env: {} });
    await expect(runCli(["--version"], deps)).resolves.toBe(0);
    expect(deps.output).toMatchObject({ stdout: `answra ${CLI_VERSION}\n` });
  });

  it("returns 2 for usage errors and points to help", async () => {
    const deps = createDependencies();
    await expect(runCli(["code", "--bad"], deps)).resolves.toBe(2);
    expect((deps.output as OutputPort & { stderr: string }).stderr).toBe(
      "error: 未知选项：--bad\n运行 `answra --help` 查看用法。\n",
    );
  });

  it("returns 1 when model configuration is missing", async () => {
    const deps = createDependencies({ env: {} });
    await expect(runCli(["code", "hello"], deps)).resolves.toBe(1);
    expect((deps.output as OutputPort & { stderr: string }).stderr).toContain(
      "缺少 ANSWRA_AI_BASE_URL",
    );
  });

  it("starts interactive model setup instead of failing when config is missing", async () => {
    const deps = createDependencies({ env: {}, input: createInput("", true) });

    await expect(runCli(["code"], deps)).resolves.toBe(0);

    expect(deps.runTui).toHaveBeenCalledWith(
      expect.objectContaining({ createSession: expect.any(Function) }),
    );
    const options = vi.mocked(deps.runTui).mock.calls[0]?.[0];
    expect(options?.session).toBeUndefined();
    expect(deps.createSessionHost).not.toHaveBeenCalled();
  });

  it("uses the API key entered in the TUI for the new session", async () => {
    const tokens: string[] = [];
    const deps = createDependencies({ env: {}, input: createInput("", true), tokens });
    await expect(runCli(["code"], deps)).resolves.toBe(0);

    const options = vi.mocked(deps.runTui).mock.calls[0]?.[0];
    const model: ConversationModelConfig = {
      chat: { baseUrl: "http://127.0.0.1:9999/v1", model: "qwen", auth: "local" },
      answer: { baseUrl: "http://127.0.0.1:9999/v1", model: "qwen", auth: "local" },
    };
    const session = options?.createSession?.(model, "sk-entered");
    await session?.open();
    await session?.send("hello");

    expect(tokens).toEqual(["sk-entered"]);
    session?.close();
  });

  it("runs a one-shot request from a positional prompt", async () => {
    const sent: ConversationSendRequest[] = [];
    const deps = createDependencies({ sent });
    const cleanup = vi.fn();
    deps.onInterrupt = vi.fn(() => cleanup);

    await expect(runCli(["code", "hello"], deps)).resolves.toBe(0);

    expect(sent).toEqual([{ text: "hello", images: [] }]);
    expect(deps.createSessionHost).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: process.cwd() }),
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(deps.output).toMatchObject({ stdout: "hi\n", stderr: "" });
  });

  it("uses the keychain key when no flag or env key is set", async () => {
    const tokens: string[] = [];
    const modelCredentials = createModelCredentials("stored-key");
    const deps = createDependencies({
      env: {
        ANSWRA_AI_BASE_URL: "http://127.0.0.1:1234/v1",
        ANSWRA_MODEL: "test-model",
      },
      modelCredentials,
      tokens,
    });

    await expect(runCli(["code", "hello"], deps)).resolves.toBe(0);

    expect(tokens).toEqual(["stored-key"]);
  });

  it("prefers the env key over the keychain key", async () => {
    const tokens: string[] = [];
    const modelCredentials = createModelCredentials("stored-key");
    const deps = createDependencies({ modelCredentials, tokens });

    await expect(runCli(["code", "hello"], deps)).resolves.toBe(0);

    expect(tokens).toEqual(["test-key"]);
    expect(modelCredentials.read).not.toHaveBeenCalled();
  });

  it("falls back to the desktop shared local model config", async () => {
    const shared: ClientConfig = {
      version: 1,
      model: {
        source: "cloud",
        local: {
          baseUrl: "http://127.0.0.1:1234/v1",
          chatModel: "shared-model",
          answerModel: "shared-answer",
        },
      },
    };
    const deps = createDependencies({
      env: {},
      modelSettings: createModelSettings(shared),
    });

    await expect(runCli(["code", "hello"], deps)).resolves.toBe(0);
    const host = (
      deps.createSessionHost as unknown as {
        mock: { results: Array<{ value: CodingSessionHost }> };
      }
    ).mock.results[0]?.value;
    expect(host?.configure).toHaveBeenCalledWith({
      chat: { baseUrl: "http://127.0.0.1:1234/v1", model: "shared-model", auth: "local" },
      answer: {
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "shared-answer",
        auth: "local",
      },
    });
    expect(deps.output).toMatchObject({ stdout: "hi\n", stderr: "" });
  });

  it("reads non-TTY stdin when no prompt is provided", async () => {
    const sent: ConversationSendRequest[] = [];
    const deps = createDependencies({ sent, input: createInput("from stdin\n") });

    await expect(runCli(["code"], deps)).resolves.toBe(0);
    expect(sent).toEqual([{ text: "from stdin", images: [] }]);
  });

  it("starts the TUI for a TTY invocation without a prompt", async () => {
    const deps = createDependencies({ input: createInput("", true) });

    await expect(runCli(["code"], deps)).resolves.toBe(0);
    expect(deps.runTui).toHaveBeenCalledWith(
      expect.objectContaining({ altScreen: true, workspaceRoot: process.cwd() }),
    );
    expect(deps.createSessionHost).toHaveBeenCalledWith(
      expect.objectContaining({ onSnapshot: expect.any(Function) }),
    );
  });

  it("passes --no-alt-screen to the TUI runner", async () => {
    const deps = createDependencies({ input: createInput("", true) });

    await expect(runCli(["code", "--no-alt-screen"], deps)).resolves.toBe(0);
    expect(deps.runTui).toHaveBeenCalledWith(expect.objectContaining({ altScreen: false }));
  });

  it("saves and shows the shared local model without secrets", async () => {
    const modelSettings = createModelSettings();
    const setDeps = createDependencies({ env: {}, modelSettings });

    await expect(
      runCli(
        [
          "config",
          "set",
          "--base-url",
          "http://127.0.0.1:1234/v1/",
          "--model",
          " qwen ",
          "--answer-model",
          "qwen-vl",
        ],
        setDeps,
      ),
    ).resolves.toBe(0);
    expect(setDeps.output).toMatchObject({ stdout: "已保存本地模型：qwen\n", stderr: "" });

    const showDeps = createDependencies({
      env: {},
      modelSettings,
      output: createOutput(),
    });
    await expect(runCli(["config", "show"], showDeps)).resolves.toBe(0);
    expect(showDeps.output).toMatchObject({
      stdout:
        "source: local\nbaseUrl: http://127.0.0.1:1234/v1\nchatModel: qwen\nanswerModel: qwen-vl\nconfigured: true\n",
      stderr: "",
    });
  });

  it("saves the API key from config set into the keychain", async () => {
    const modelSettings = createModelSettings();
    const modelCredentials = createModelCredentials();
    const deps = createDependencies({ env: {}, modelSettings, modelCredentials });

    await expect(
      runCli(
        [
          "config",
          "set",
          "--base-url",
          "http://127.0.0.1:1234/v1",
          "--model",
          "qwen",
          "--api-key",
          "sk-config",
        ],
        deps,
      ),
    ).resolves.toBe(0);

    expect(modelCredentials.current()).toBe("sk-config");
  });

  it("clears the shared local model and keychain on config unset", async () => {
    const modelSettings = createModelSettings({
      version: 1,
      model: {
        source: "local",
        local: { baseUrl: "http://127.0.0.1:1234/v1", chatModel: "qwen" },
      },
    });
    const modelCredentials = createModelCredentials("old-key");
    const deps = createDependencies({ env: {}, modelSettings, modelCredentials });

    await expect(runCli(["config", "unset"], deps)).resolves.toBe(0);
    expect(deps.output).toMatchObject({ stdout: "已清除共享本地模型配置。\n" });
    expect(modelCredentials.current()).toBeNull();

    const showDeps = createDependencies({ env: {}, modelSettings, output: createOutput() });
    await expect(runCli(["config", "show"], showDeps)).resolves.toBe(0);
    expect(showDeps.output).toMatchObject({
      stdout: "source: cloud\nbaseUrl: \nchatModel: \nanswerModel: \nconfigured: false\n",
    });
  });
});

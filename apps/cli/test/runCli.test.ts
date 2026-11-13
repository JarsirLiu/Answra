import type { ClientConfig } from "@answra/config";
import type {
  ConversationModelConfig,
  ConversationSendRequest,
  ConversationSnapshot,
} from "@answra/shared";
import type { AgentEvent, AgentEventEnvelope } from "@answra/shared/schema";
import { describe, expect, it, vi } from "vitest";
import type { CliDependencies } from "../src/cli/dependencies";
import { CLI_HELP } from "../src/cli/help";
import { runCli } from "../src/cli/runCli";
import type { ModelSettingsStore } from "../src/model/ports";
import { ModelSettingsService } from "../src/model/settingsService";
import type { CodingSessionHost } from "../src/session/codingSession";
import type { InputPort } from "../src/transport/input";
import type { OutputPort } from "../src/transport/output";
import { CLI_VERSION } from "../src/version";

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
  messages: [],
};

let sequence = 0;

function envelope(event: AgentEvent): AgentEventEnvelope {
  sequence += 1;
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    conversationId: "conversation-1",
    runId: "run-1",
    attemptId: "attempt-1",
    sequence,
    aggregateRevision: 0,
    producerId: "test",
    occurredAt: new Date().toISOString(),
    event,
  };
}

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
      return { runId: "run-1" };
    }),
    cancel: vi.fn(),
    waitForRun: vi.fn(async () => {}),
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
    createSessionHost: vi.fn(({ emitEvent }) => {
      const send = host.send;
      host.send = vi.fn(async (conversationId, request, token) => {
        emitEvent(envelope({ type: "text-delta", partId: "text-1", delta: "hi" }));
        emitEvent(envelope({ type: "text-end", partId: "text-1" }));
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

  it("clears the shared local model on config unset", async () => {
    const modelSettings = createModelSettings({
      version: 1,
      model: {
        source: "local",
        local: { baseUrl: "http://127.0.0.1:1234/v1", chatModel: "qwen" },
      },
    });
    const deps = createDependencies({ env: {}, modelSettings });

    await expect(runCli(["config", "unset"], deps)).resolves.toBe(0);
    expect(deps.output).toMatchObject({ stdout: "已清除共享本地模型配置。\n" });

    const showDeps = createDependencies({ env: {}, modelSettings, output: createOutput() });
    await expect(runCli(["config", "show"], showDeps)).resolves.toBe(0);
    expect(showDeps.output).toMatchObject({
      stdout: "source: cloud\nbaseUrl: \nchatModel: \nanswerModel: \nconfigured: false\n",
    });
  });
});

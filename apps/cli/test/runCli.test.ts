import type { ConversationSendRequest, ConversationSnapshot } from "@answra/shared";
import type { AgentEvent, AgentEventEnvelope } from "@answra/shared/schema";
import { describe, expect, it, vi } from "vitest";
import type { CliDependencies } from "../src/cli/dependencies";
import { CLI_HELP } from "../src/cli/help";
import { runCli } from "../src/cli/runCli";
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
  } = {},
): CliDependencies {
  const { sent: sentOverride, ...depsOverrides } = overrides;
  const sent = sentOverride ?? [];
  const host: CodingSessionHost = {
    configure: vi.fn(),
    createConversation: vi.fn(async () => snapshot),
    clearConversation: vi.fn(async () => snapshot),
    send: vi.fn(async (_conversationId, request) => {
      sent.push(request);
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
});

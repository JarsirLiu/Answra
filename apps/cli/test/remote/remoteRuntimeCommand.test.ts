import {
  createRemoteCredentialRecord,
  createRemoteHostAccessKeyRecord,
  generateRemoteAccessKey,
  RemoteHostSession,
  type RemoteSignalingTimers,
} from "@answra/remote";
import {
  createFakeHostCommandPort,
  createFakeRemoteLinkPair,
  createFakeSignalingServer,
  createMemoryCredentialStore,
  createMemoryHostKeyStore,
} from "@answra/remote/testing";
import { describe, expect, it, vi } from "vitest";
import type { CliDependencies, RemoteKeyDependencies } from "../../src/cli/dependencies";
import { runCli } from "../../src/cli/runCli";
import type { ModelSettingsStore } from "../../src/model/ports";
import { ModelSettingsService } from "../../src/model/settingsService";
import type { RemoteHostHandle } from "../../src/remote/host/startRemoteHost";
import type { RemoteRuntimeDependencies } from "../../src/remote/runtimeDependencies";
import type { RemoteSignalingService } from "../../src/remote/signaling/remoteSignalingService";
import type { CodingSessionHost } from "../../src/session/codingSession";
import type { InputPort } from "../../src/transport/input";
import type { OutputPort } from "../../src/transport/output";
import type { TuiRunOptions } from "../../src/tui/runTui";

const NOW = new Date("2026-11-14T00:00:00.000Z");

const timers: RemoteSignalingTimers = {
  after(delayMs, callback) {
    const id = setTimeout(callback, delayMs);
    return () => clearTimeout(id);
  },
};

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

function createInput(isTTY: boolean): InputPort {
  return { isTTY, readAll: vi.fn(async () => "") };
}

function createRemoteKeys(overrides: Partial<RemoteKeyDependencies> = {}): RemoteKeyDependencies {
  return {
    hostKeys: createMemoryHostKeyStore(),
    credentials: createMemoryCredentialStore(),
    promptSecret: vi.fn(async () => ""),
    now: () => NOW,
    ...overrides,
  };
}

function createDependencies(
  remoteKeys: RemoteKeyDependencies,
  remoteRuntime: RemoteRuntimeDependencies,
  overrides: Partial<CliDependencies> = {},
): CliDependencies {
  const store: ModelSettingsStore = {
    read: async () => null,
    write: async () => {},
  };
  const host: CodingSessionHost = {
    configure: vi.fn(),
    createConversation: vi.fn(async (conversationId) => ({
      conversationId,
      eventRevision: 0,
      messages: [],
    })),
    clearConversation: vi.fn(async (conversationId) => ({
      conversationId,
      eventRevision: 0,
      messages: [],
    })),
    send: vi.fn(async () => ({ runId: "run-1" })),
    enqueue: vi.fn(async (conversationId) => ({
      queueId: "queue-1",
      status: "started" as const,
      position: 0 as const,
      runId: "run-1",
      snapshot: {
        conversationId,
        eventRevision: 0,
        messages: [],
      },
    })),
    waitForQueueStart: vi.fn(async (conversationId, queueId) => ({
      queueId,
      runId: "run-1",
      snapshot: {
        conversationId,
        eventRevision: 0,
        messages: [],
      },
    })),
    cancel: vi.fn(),
    waitForRun: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  return {
    env: {},
    input: createInput(false),
    output: createOutput(),
    cwd: process.cwd(),
    modelSettings: new ModelSettingsService(store),
    modelCredentials: {
      read: async () => null,
      write: async () => {},
      clear: async () => {},
    },
    modelCatalog: { list: async () => [] },
    remoteKeys,
    remoteRuntime,
    createSessionHost: () => host,
    createConversationId: () => "conversation-1",
    onInterrupt: () => () => {},
    runTui: async () => 0,
    ...overrides,
  };
}

function createSignalingService(): {
  service: RemoteSignalingService;
  disconnect(): void;
} {
  const server = createFakeSignalingServer();
  return {
    service: {
      requestTicket: async () => ({
        ticket: "ticket-1",
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      }),
      openChannel: () => server.connect(),
    },
    disconnect: () => server.disconnectAll(),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}

describe("answra remote host/attach", () => {
  it("starts a host with the selected key and stops on interrupt", async () => {
    const generated = generateRemoteAccessKey({ now: NOW });
    const record = await createRemoteHostAccessKeyRecord(generated);
    const remoteKeys = createRemoteKeys({
      hostKeys: createMemoryHostKeyStore([record]),
    });
    const signaling = createSignalingService();
    let interrupt: (() => void) | undefined;
    const dispose = vi.fn();
    const port = createFakeHostCommandPort();
    const output = createOutput();
    const deps = createDependencies(
      remoteKeys,
      {
        signaling: signaling.service,
        timers,
        createLink: () => {
          throw new Error("host command must not create a link before a controller joins");
        },
        createId: () => "host-1",
      },
      {
        output,
        createRemoteHost: () => ({ port, dispose }),
        onInterrupt: (handler) => {
          interrupt = handler;
          return () => {
            interrupt = undefined;
          };
        },
      },
    );

    try {
      const pending = runCli(["remote", "host"], deps);
      await waitFor(() => output.stdout.includes("Remote host 已启动"));
      expect(output.stdout).toContain(record.roomId);
      expect(output.stdout).toContain(record.keyId);
      if (interrupt === undefined) throw new Error("interrupt handler missing");
      interrupt();
      await expect(pending).resolves.toBe(0);
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      signaling.disconnect();
    }
  });

  it("rejects a host start without an active access key", async () => {
    const remoteKeys = createRemoteKeys();
    const signaling = createSignalingService();
    const output = createOutput();
    const deps = createDependencies(
      remoteKeys,
      {
        signaling: signaling.service,
        timers,
        createLink: () => {
          throw new Error("unexpected link");
        },
        createId: () => "host-1",
      },
      { output },
    );

    try {
      await expect(runCli(["remote", "host"], deps)).resolves.toBe(2);
      expect(output.stderr).toContain("尚未创建有效的 host 访问密钥");
    } finally {
      signaling.disconnect();
    }
  });

  it("attaches as controller and opens the remote coding TUI", async () => {
    const generated = generateRemoteAccessKey({ now: NOW });
    const record = await createRemoteHostAccessKeyRecord(generated);
    const credential = createRemoteCredentialRecord(generated.key, { savedAt: NOW });
    const hostPort = createFakeHostCommandPort();
    const links = createFakeRemoteLinkPair();
    const hostSession = new RemoteHostSession({
      host: hostPort,
      link: links.host,
      hostKeys: createMemoryHostKeyStore([record]),
      hostId: "host-1",
      workspaceRoot: "D:/remote-workspace",
      now: () => NOW,
    });
    const signaling = createSignalingService();
    let nextId = 0;
    let tuiOptions: TuiRunOptions | undefined;
    const deps = createDependencies(
      createRemoteKeys({ credentials: createMemoryCredentialStore(credential) }),
      {
        signaling: signaling.service,
        timers,
        createLink: () => links.controller,
        createId: () => `peer-${++nextId}`,
      },
      {
        input: createInput(true),
        runTui: async (options) => {
          tuiOptions = options;
          if (options.session === undefined) throw new Error("remote TUI session missing");
          await options.session.open();
          return 0;
        },
      },
    );

    try {
      await expect(runCli(["remote", "attach", "--no-alt-screen"], deps)).resolves.toBe(0);
      expect(tuiOptions?.model).toBe("local-model");
      expect(tuiOptions?.workspaceRoot).toBe("D:/remote-workspace");
      expect(tuiOptions?.altScreen).toBe(false);
      expect(hostPort.appliedModels).toHaveLength(1);
    } finally {
      hostSession.close();
      links.disconnect();
      signaling.disconnect();
    }
  });

  it("prompts securely for a connection code when no controller credential is stored", async () => {
    const signaling = createSignalingService();
    const output = createOutput();
    const remoteKeys = createRemoteKeys();
    const deps = createDependencies(
      remoteKeys,
      {
        signaling: signaling.service,
        timers,
        createLink: () => {
          throw new Error("unexpected link");
        },
        createId: () => "controller-1",
      },
      { input: createInput(true), output },
    );

    try {
      await expect(runCli(["remote", "attach"], deps)).resolves.toBe(2);
      expect(output.stderr).toContain("远程访问密钥格式无效");
      expect(remoteKeys.promptSecret).toHaveBeenCalledWith("输入远程连接码：");
    } finally {
      signaling.disconnect();
    }
  });

  it("keeps host handles typed for future command wiring", () => {
    const handle: RemoteHostHandle = {
      done: Promise.resolve(),
      stop: async () => {},
    };
    expect(handle).toBeDefined();
  });
});

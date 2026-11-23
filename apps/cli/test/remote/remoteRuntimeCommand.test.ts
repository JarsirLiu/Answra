import {
  createRemoteHostAccessKeyRecord,
  generateRemoteAccessKey,
  type RemoteSignalingTimers,
} from "@answra/remote";
import {
  createFakeHostCommandPort,
  createFakeSignalingServer,
  createMemoryHostKeyStore,
} from "@answra/remote/testing";
import type {
  RemoteHostHandle,
  RemoteRuntimeDependencies,
  RemoteSignalingService,
} from "@answra/remote-node";
import { describe, expect, it, vi } from "vitest";
import type { CliDependencies, RemoteKeyDependencies } from "../../src/cli/dependencies";
import { runCli } from "../../src/cli/runCli";
import type { ModelSettingsStore } from "../../src/model/ports";
import { ModelSettingsService } from "../../src/model/settingsService";
import type { CodingSessionHost } from "../../src/session/codingSession";
import type { InputPort } from "../../src/transport/input";
import type { OutputPort } from "../../src/transport/output";

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
      lastSeq: 0,
      messages: [],
    })),
    clearConversation: vi.fn(async (conversationId) => ({
      conversationId,
      lastSeq: 0,
      messages: [],
    })),
    send: vi.fn(async () => ({ turnId: "turn-1" })),
    enqueue: vi.fn(async (conversationId) => ({
      queueId: "queue-1",
      status: "started" as const,
      position: 0 as const,
      turnId: "turn-1",
      snapshot: {
        conversationId,
        lastSeq: 0,
        messages: [],
      },
    })),
    waitForQueueStart: vi.fn(async (conversationId, queueId) => ({
      queueId,
      turnId: "turn-1",
      snapshot: {
        conversationId,
        lastSeq: 0,
        messages: [],
      },
    })),
    cancel: vi.fn(),
    waitForTurn: vi.fn(async () => {}),
    readFrames: vi.fn(async () => []),
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

describe("answra remote host", () => {
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

  it("keeps host handles typed for future command wiring", () => {
    const handle: RemoteHostHandle = {
      done: Promise.resolve(),
      state: () => "waiting",
      onState: () => () => undefined,
      onError: () => () => undefined,
      stop: async () => {},
    };
    expect(handle).toBeDefined();
  });
});

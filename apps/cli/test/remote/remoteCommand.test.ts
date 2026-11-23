import { createMemoryHostKeyStore } from "@answra/remote/testing";
import { describe, expect, it, vi } from "vitest";
import type { CliDependencies, RemoteKeyDependencies } from "../../src/cli/dependencies";
import { runCli } from "../../src/cli/runCli";
import type { ModelSettingsStore } from "../../src/model/ports";
import { ModelSettingsService } from "../../src/model/settingsService";
import type { CodingSessionHost } from "../../src/session/codingSession";
import type { InputPort } from "../../src/transport/input";
import type { OutputPort } from "../../src/transport/output";

const NOW = new Date("2026-11-13T00:00:00.000Z");

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

function createInput(isTTY = true): InputPort {
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
  input: InputPort = createInput(),
  output: OutputPort = createOutput(),
): CliDependencies {
  const store: ModelSettingsStore = {
    read: async () => null,
    write: async () => {},
  };
  const host: CodingSessionHost = {
    configure: vi.fn(),
    createConversation: vi.fn(async () => ({
      conversationId: "conversation-1",
      lastSeq: 0,
      messages: [],
    })),
    clearConversation: vi.fn(async () => ({
      conversationId: "conversation-1",
      lastSeq: 0,
      messages: [],
    })),
    send: vi.fn(async () => ({ turnId: "turn-1" })),
    enqueue: vi.fn(async () => ({
      queueId: "queue-1",
      status: "started" as const,
      position: 0 as const,
      turnId: "turn-1",
      snapshot: {
        conversationId: "conversation-1",
        lastSeq: 0,
        messages: [],
      },
    })),
    waitForQueueStart: vi.fn(async (_conversationId, queueId) => ({
      queueId,
      turnId: "turn-1",
      snapshot: {
        conversationId: "conversation-1",
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
    input,
    output,
    cwd: process.cwd(),
    modelSettings: new ModelSettingsService(store),
    modelCredentials: {
      read: async () => null,
      write: async () => {},
      clear: async () => {},
    },
    modelCatalog: { list: async () => [] },
    remoteKeys,
    createSessionHost: () => host,
    createConversationId: () => "conversation-1",
    onInterrupt: () => () => {},
    runTui: async () => 0,
  };
}

describe("answra remote key commands", () => {
  it("creates, lists and revokes a host key without printing the secret in list output", async () => {
    const remoteKeys = createRemoteKeys();
    const output = createOutput();
    const deps = createDependencies(remoteKeys, createInput(), output);

    expect(
      await runCli(["remote", "key", "create", "--days", "7", "--label", "office"], deps),
    ).toBe(0);
    const created = output.stdout;
    const key = /answra1\.[0-9a-f.]+/.exec(created)?.[0];
    if (key === undefined) throw new Error("access key missing from output");
    const record = (await remoteKeys.hostKeys.list())[0];
    if (record === undefined) throw new Error("host key missing");

    expect(created).toContain("只显示这一次");
    expect(created).toContain(record.keyId);
    expect(created).toContain("2026-11-20T00:00:00.000Z");
    expect(record.label).toBe("office");

    output.stdout = "";
    expect(await runCli(["remote", "key", "list"], deps)).toBe(0);
    expect(output.stdout).toContain(record.keyId);
    expect(output.stdout).toContain("active");
    expect(output.stdout).not.toContain(key);

    expect(await runCli(["remote", "key", "revoke", record.keyId], deps)).toBe(0);
    output.stdout = "";
    expect(await runCli(["remote", "key", "list"], deps)).toBe(0);
    expect(output.stdout).toContain("revoked");
  });

  it("rejects non-interactive key creation and invalid day ranges", async () => {
    const nonInteractiveOutput = createOutput();
    const nonInteractive = createDependencies(
      createRemoteKeys(),
      createInput(false),
      nonInteractiveOutput,
    );
    expect(await runCli(["remote", "key", "create"], nonInteractive)).toBe(2);
    expect(nonInteractiveOutput.stderr).toContain("需要交互终端");

    const invalidDaysOutput = createOutput();
    const invalidDays = createDependencies(createRemoteKeys(), createInput(), invalidDaysOutput);
    expect(await runCli(["remote", "key", "create", "--days", "6"], invalidDays)).toBe(2);
    expect(invalidDaysOutput.stderr).toContain("7-30");
  });

  it("prints remote help", async () => {
    const output = createOutput();
    const deps = createDependencies(createRemoteKeys(), createInput(), output);
    expect(await runCli(["remote", "--help"], deps)).toBe(0);
    expect(output.stdout).toContain("Answra Remote");
  });
});

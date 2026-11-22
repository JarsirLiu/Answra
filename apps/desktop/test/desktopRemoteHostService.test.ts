import type { RemoteHostConnectionState, RemoteOperationError, Unsubscribe } from "@answra/remote";
import { createMemoryHostKeyStore } from "@answra/remote/testing";
import type { startRemoteHost } from "@answra/remote-node";
import { describe, expect, it, vi } from "vitest";
import type { DesktopRemoteAgentPort } from "../src/main/remote/host/agentPort";
import { DesktopRemoteHostService } from "../src/main/remote/host/desktopRemoteHostService";

const NOW = new Date("2026-11-21T00:00:00.000Z");

function snapshot(conversationId: string) {
  return { conversationId, eventRevision: 0, lastSeq: 0, messages: [] };
}

function createAgent(): DesktopRemoteAgentPort {
  return {
    listConversationSessions: async () => ({ items: [] }),
    createConversation: async (conversationId) => snapshot(conversationId),
    clearConversation: async (conversationId) => snapshot(conversationId),
    getSnapshot: async (conversationId) => snapshot(conversationId),
    readEvents: async () => [],
    send: async (command) => ({
      queueId: "queue-1",
      status: "started",
      position: 0,
      turnId: "turn-1",
      snapshot: snapshot(command.conversationId),
    }),
    waitForConversationQueue: async (_conversationId, queueId) => ({
      queueId,
      turnId: "turn-1",
      outcome: "completed",
    }),
    waitForConversationQueueStart: async (conversationId, queueId) => ({
      queueId,
      turnId: "turn-1",
      snapshot: snapshot(conversationId),
    }),
    cancelTurn: () => undefined,
    onSnapshot: () => () => undefined,
    onEvent: () => () => undefined,
  };
}

function createHandle() {
  const stateListeners = new Set<(state: RemoteHostConnectionState) => void>();
  const errorListeners = new Set<(error: RemoteOperationError) => void>();
  const handle = {
    done: new Promise<void>(() => undefined),
    state: () => "waiting" as RemoteHostConnectionState,
    onState(listener: (state: RemoteHostConnectionState) => void): Unsubscribe {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onError(listener: (error: RemoteOperationError) => void): Unsubscribe {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    stop: vi.fn(async () => undefined),
  };
  return {
    handle,
    emitState(state: RemoteHostConnectionState) {
      for (const listener of stateListeners) listener(state);
    },
    emitError(error: RemoteOperationError) {
      for (const listener of errorListeners) listener(error);
    },
  };
}

function createService(options: { startHost?: typeof startRemoteHost } = {}) {
  const hostKeys = createMemoryHostKeyStore();
  const fake = createHandle();
  const startHost = options.startHost ?? vi.fn(async () => fake.handle);
  const service = new DesktopRemoteHostService({
    configDir: "C:/data",
    apiBaseUrl: "https://example.test",
    getAccessToken: async () => "token",
    getWorkspaceRoot: () => "D:/workspace",
    agent: createAgent(),
    hostKeys,
    startHost,
    now: () => NOW,
  });
  return { service, hostKeys, startHost, ...fake };
}

describe("DesktopRemoteHostService", () => {
  it("creates a connection key and starts the host with the selected room", async () => {
    const { service, startHost } = createService();

    const created = await service.createKey();
    expect(created.key).toMatch(/^answra1\./);
    expect((await service.getStatus()).key?.keyId).toBe(created.keyId);

    const status = await service.start();
    expect(startHost).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: expect.any(String),
        workspaceRoot: "D:/workspace",
      }),
    );
    expect(status).toMatchObject({ running: true, state: "waiting" });
  });

  it("connects with one command and revokes the key on disconnect", async () => {
    const { service, handle } = createService();

    const connected = await service.connect();
    expect(connected.key.key).toMatch(/^answra1\./);
    expect(connected.status).toMatchObject({ running: true, state: "waiting" });

    const disconnected = await service.disconnect();
    expect(disconnected).toMatchObject({ running: false, state: "stopped", key: null });
    expect(handle.stop).toHaveBeenCalledTimes(1);
  });

  it("revokes a newly created key when start fails", async () => {
    const { service, hostKeys } = createService({
      startHost: vi.fn(async () => {
        throw new Error("signaling unavailable");
      }),
    });

    await expect(service.connect()).rejects.toThrow("signaling unavailable");
    const records = await hostKeys.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.revokedAt).toBe(NOW.toISOString());
    expect((await service.getStatus()).key).toBeNull();
  });

  it("reflects connection state and stops the active handle", async () => {
    const { service, handle, emitState } = createService();
    await service.createKey();
    await service.start();

    emitState("ready");
    await vi.waitFor(async () => {
      expect(await service.getStatus()).toMatchObject({ running: true, state: "ready" });
    });

    expect((await service.stop()).state).toBe("stopped");
    expect(handle.stop).toHaveBeenCalledTimes(1);
  });

  it("stops the host when the account is signed out", async () => {
    const { service, handle } = createService();
    await service.createKey();
    await service.start();

    await service.onAuthStatus(false);

    expect(handle.stop).toHaveBeenCalledTimes(1);
    expect((await service.getStatus()).state).toBe("stopped");
  });

  it("stops a host that finishes connecting after sign out", async () => {
    let resolveHandle: (handle: ReturnType<typeof createHandle>["handle"]) => void = () =>
      undefined;
    const pending = new Promise<ReturnType<typeof createHandle>["handle"]>((resolve) => {
      resolveHandle = resolve;
    });
    const startHost = vi.fn(() => pending);
    const { service, handle } = createService({ startHost });
    await service.createKey();

    const starting = service.start();
    await vi.waitFor(() => expect(startHost).toHaveBeenCalledTimes(1));
    await service.onAuthStatus(false);
    resolveHandle(handle);

    await starting;
    await vi.waitFor(() => expect(handle.stop).toHaveBeenCalledTimes(1));
    expect((await service.getStatus()).state).toBe("stopped");
  });
});

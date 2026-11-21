import { describe, expect, it, vi } from "vitest";
import {
  createRemoteCredentialRecord,
  createRemoteHostAccessKeyRecord,
  generateRemoteAccessKey,
  type RemoteControllerAttempt,
  RemoteControllerConnection,
  RemoteControllerSession,
  RemoteHostSession,
  RemoteReconnectPolicy,
  type RemoteSignalingTimers,
} from "../src";
import {
  createFakeHostCommandPort,
  createFakeRemoteLinkPair,
  createMemoryHostKeyStore,
  flushFakeRemoteLink,
} from "../src/testing";

const NOW = new Date("2026-11-21T00:00:00.000Z");

interface ManualTimers {
  timers: RemoteSignalingTimers;
  fireNext(): void;
  pending(): number;
  delays: number[];
}

function createManualTimers(): ManualTimers {
  const entries: Array<{ callback: () => void; cancelled: boolean; delayMs: number }> = [];
  const delays: number[] = [];
  return {
    timers: {
      after(delayMs, callback) {
        const entry = { callback, cancelled: false, delayMs };
        entries.push(entry);
        delays.push(delayMs);
        return () => {
          entry.cancelled = true;
        };
      },
    },
    fireNext() {
      const entry = entries.find((candidate) => !candidate.cancelled);
      if (entry === undefined) throw new Error("no pending timer");
      entry.cancelled = true;
      entry.callback();
    },
    pending() {
      return entries.filter((entry) => !entry.cancelled).length;
    },
    delays,
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
  await flushFakeRemoteLink();
}

async function createAttempt(): Promise<RemoteControllerAttempt> {
  const generated = generateRemoteAccessKey({ now: NOW });
  const record = await createRemoteHostAccessKeyRecord(generated);
  const credential = createRemoteCredentialRecord(generated.key, { savedAt: NOW });
  const link = createFakeRemoteLinkPair();
  const host = new RemoteHostSession({
    host: createFakeHostCommandPort(),
    link: link.host,
    hostKeys: createMemoryHostKeyStore([record]),
    hostId: "host-1",
    workspaceRoot: "D:/workspace",
    now: () => NOW,
  });
  const session = new RemoteControllerSession({
    link: link.controller,
    sessionId: `session-${Math.random()}`,
    peerId: "controller-1",
    credential,
  });
  return {
    session,
    close() {
      session.close();
      host.close();
      link.disconnect();
    },
  };
}

function policy(): RemoteReconnectPolicy {
  return new RemoteReconnectPolicy({
    now: () => 0,
    random: () => 0.5,
    baseDelaysMs: [1_000, 2_000, 4_000],
    maxAttempts: 3,
    maxElapsedMs: 120_000,
  });
}

describe("remote controller connection", () => {
  it("reconnects after the link closes and emits a new ready session", async () => {
    const timers = createManualTimers();
    const attempts: RemoteControllerAttempt[] = [];
    const states: string[] = [];
    const sessions: string[] = [];
    let resyncCount = 0;
    const connection = new RemoteControllerConnection({
      timers: timers.timers,
      policy: policy(),
      createAttempt: async () => {
        const attempt = await createAttempt();
        attempts.push(attempt);
        return attempt;
      },
      resync: async () => {
        resyncCount += 1;
      },
    });
    connection.onState((state) => states.push(state));
    connection.onSession(() => sessions.push("session"));

    await connection.connect();
    expect(connection.state()).toBe("ready");
    expect(resyncCount).toBe(1);

    attempts[0]?.close();
    await flush();
    expect(connection.state()).toBe("interrupted");
    expect(timers.pending()).toBe(1);

    timers.fireNext();
    await vi.waitFor(() => expect(connection.state()).toBe("ready"));
    await flush();
    expect(attempts).toHaveLength(2);
    expect(resyncCount).toBe(2);
    expect(sessions).toHaveLength(2);
    expect(states).toContain("interrupted");
    expect(states).toContain("reconnecting");

    connection.close();
  });

  it("fails closed on a terminal authentication error without scheduling a retry", async () => {
    const timers = createManualTimers();
    const generated = generateRemoteAccessKey({ now: NOW });
    const record = await createRemoteHostAccessKeyRecord(generated);
    const wrongCredential = createRemoteCredentialRecord(
      generateRemoteAccessKey({ now: NOW }).key,
      { savedAt: NOW },
    );
    const link = createFakeRemoteLinkPair();
    const host = new RemoteHostSession({
      host: createFakeHostCommandPort(),
      link: link.host,
      hostKeys: createMemoryHostKeyStore([record]),
      hostId: "host-1",
      workspaceRoot: "D:/workspace",
      now: () => NOW,
    });
    const session = new RemoteControllerSession({
      link: link.controller,
      sessionId: "session-1",
      peerId: "controller-1",
      credential: wrongCredential,
    });
    const connection = new RemoteControllerConnection({
      timers: timers.timers,
      policy: policy(),
      createAttempt: async () => ({ session, close: () => session.close() }),
    });

    const errors: string[] = [];
    connection.onError((error) => errors.push(error.code));

    await expect(connection.connect()).rejects.toMatchObject({ code: "unauthorized" });
    expect(connection.state()).toBe("closed");
    expect(timers.pending()).toBe(0);
    expect(errors).toEqual(["unauthorized"]);

    host.close();
    link.disconnect();
  });

  it("reconnectNow discards the active link and reconnects without waiting for a timer", async () => {
    const timers = createManualTimers();
    const attempts: RemoteControllerAttempt[] = [];
    const connection = new RemoteControllerConnection({
      timers: timers.timers,
      policy: policy(),
      createAttempt: async () => {
        const attempt = await createAttempt();
        attempts.push(attempt);
        return attempt;
      },
    });

    await connection.connect();
    connection.reconnectNow();
    await vi.waitFor(() => expect(connection.state()).toBe("ready"));
    await flush();

    expect(attempts).toHaveLength(2);
    expect(timers.pending()).toBe(0);

    connection.close();
  });
});

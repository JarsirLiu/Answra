import { describe, expect, it, vi } from "vitest";
import {
  createRemoteHostAccessKeyRecord,
  generateRemoteAccessKey,
  type RemoteHostAttempt,
  RemoteHostConnection,
  RemoteHostSession,
  RemoteReconnectPolicy,
  RemoteSignalingSession,
  type RemoteSignalingTimers,
} from "../src";
import {
  createFakeHostCommandPort,
  createFakeRemoteLinkPair,
  createFakeSignalingServer,
  createMemoryHostKeyStore,
} from "../src/testing";

const NOW = new Date("2026-11-21T00:00:00.000Z");
const ROOM_ID = "room-1";

interface ManualTimers {
  timers: RemoteSignalingTimers;
  fireNext(): void;
  pending(): number;
  delays: number[];
}

function createManualTimers(): ManualTimers {
  const entries: Array<{ callback: () => void; cancelled: boolean }> = [];
  const delays: number[] = [];
  return {
    timers: {
      after(delayMs, callback) {
        const entry = { callback, cancelled: false };
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

function policy(): RemoteReconnectPolicy {
  return new RemoteReconnectPolicy({
    now: () => 0,
    random: () => 0.5,
    baseDelaysMs: [1_000, 2_000, 4_000],
    maxAttempts: 3,
    maxElapsedMs: 120_000,
  });
}

async function createHostConnection(timers: ManualTimers) {
  const server = createFakeSignalingServer();
  const generated = generateRemoteAccessKey({ now: NOW });
  const record = await createRemoteHostAccessKeyRecord(generated);
  const hostKeys = createMemoryHostKeyStore([record]);
  const hostPort = createFakeHostCommandPort();
  const attempts: RemoteHostAttempt[] = [];
  let signalingSessions = 0;

  const createSignaling = async (): Promise<RemoteSignalingSession> => {
    signalingSessions += 1;
    const signaling = new RemoteSignalingSession({
      channel: server.connect(),
      roomId: ROOM_ID,
      peerId: "host-1",
      role: "host",
      timers: timers.timers,
    });
    await signaling.join();
    return signaling;
  };

  const connection = new RemoteHostConnection({
    timers: timers.timers,
    policy: policy(),
    createSignaling,
    createAttempt(_signaling) {
      const link = createFakeRemoteLinkPair();
      const session = new RemoteHostSession({
        host: hostPort,
        link: link.host,
        hostKeys,
        hostId: "host-1",
        workspaceRoot: "D:/workspace",
        now: () => NOW,
      });
      const attempt = {
        session,
        close() {
          session.close();
          link.disconnect();
        },
      };
      attempts.push(attempt);
      return attempt;
    },
  });

  return {
    connection,
    server,
    attempts,
    signalingSessions: () => signalingSessions,
  };
}

async function joinController(
  server: ReturnType<typeof createFakeSignalingServer>,
  peerId = "controller-1",
) {
  const session = new RemoteSignalingSession({
    channel: server.connect(),
    roomId: ROOM_ID,
    peerId,
    role: "controller",
    timers: { after: () => () => undefined },
  });
  await session.join();
  return session;
}

describe("remote host connection", () => {
  it("rejoins signaling after the channel closes and accepts a new controller", async () => {
    const timers = createManualTimers();
    const { connection, server, attempts, signalingSessions } = await createHostConnection(timers);

    await connection.start();
    expect(connection.state()).toBe("waiting");
    expect(signalingSessions()).toBe(1);

    const controller = await joinController(server);
    await vi.waitFor(() => expect(connection.state()).toBe("ready"));
    expect(attempts).toHaveLength(1);

    controller.close();
    await vi.waitFor(() => expect(connection.state()).toBe("waiting"));

    server.disconnectAll();
    await vi.waitFor(() => expect(connection.state()).toBe("interrupted"));
    expect(timers.pending()).toBe(1);

    timers.fireNext();
    await vi.waitFor(() => expect(connection.state()).toBe("waiting"));
    expect(signalingSessions()).toBe(2);

    const reconnectedController = await joinController(server);
    await vi.waitFor(() => expect(connection.state()).toBe("ready"));
    expect(attempts.length).toBeGreaterThanOrEqual(2);

    server.disconnectAll();
    await vi.waitFor(() => expect(connection.state()).toBe("interrupted"));
    expect(timers.delays.at(-1)).toBe(1_000);

    reconnectedController.close();
    await connection.stop();
    expect(connection.state()).toBe("closed");
  });
});

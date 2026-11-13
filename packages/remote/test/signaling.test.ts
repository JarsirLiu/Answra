import type { SignalingFrame } from "@answra/shared/schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  RemoteSignalingSession,
  type RemoteSignalingState,
  type RemoteSignalingTimers,
  type SignalingChannel,
} from "../src";
import {
  createFakeSignalingPair,
  createFakeSignalingServer,
  flushFakeSignaling,
} from "../src/testing";

interface ManualTimers {
  timers: RemoteSignalingTimers;
  fire(): void;
}

function createManualTimers(): ManualTimers {
  const pending = new Set<{ callback: () => void; cancelled: boolean }>();
  return {
    timers: {
      after(_delayMs, callback) {
        const entry = { callback, cancelled: false };
        pending.add(entry);
        return () => {
          entry.cancelled = true;
        };
      },
    },
    fire() {
      for (const entry of pending) {
        if (!entry.cancelled) entry.callback();
      }
      pending.clear();
    },
  };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function createServer() {
  const server = createFakeSignalingServer();
  cleanups.push(() => server.disconnectAll());
  return server;
}

function createSession(
  channel: SignalingChannel,
  role: "host" | "controller",
  peerId: string,
  timers: ManualTimers,
  roomId = "room-1",
) {
  const session = new RemoteSignalingSession({
    channel,
    roomId,
    peerId,
    role,
    timers: timers.timers,
  });
  cleanups.push(() => session.close());
  return session;
}

function stateOf(session: RemoteSignalingSession): RemoteSignalingState {
  return session.state();
}

describe("remote signaling session", () => {
  it("joins a room and resolves the peer already present in the acknowledgement", async () => {
    const server = createServer();
    const timers = createManualTimers();
    const host = createSession(server.connect(), "host", "host-1", timers);
    const controller = createSession(server.connect(), "controller", "controller-1", timers);

    await controller.join();
    await flushFakeSignaling();
    expect(stateOf(controller)).toBe("waiting");

    const joined = await host.join();
    await flushFakeSignaling();

    expect(joined.peers).toEqual([{ peerId: "controller-1", role: "controller" }]);
    expect(host.peer()).toEqual({ peerId: "controller-1", role: "controller" });
    expect(stateOf(host)).toBe("ready");
    expect(stateOf(controller)).toBe("ready");
  });

  it("waits for a peer, reports peer departure and returns to waiting", async () => {
    const server = createServer();
    const timers = createManualTimers();
    const host = createSession(server.connect(), "host", "host-1", timers);
    const controller = createSession(server.connect(), "controller", "controller-1", timers);
    const left: string[] = [];
    host.onPeerLeft((peer) => left.push(peer.peerId));

    await host.join();
    const peerWaiting = host.waitForPeer();
    expect(stateOf(host)).toBe("waiting");

    await controller.join();
    await flushFakeSignaling();
    await expect(peerWaiting).resolves.toEqual({
      peerId: "controller-1",
      role: "controller",
    });
    expect(stateOf(host)).toBe("ready");

    controller.close();
    await flushFakeSignaling();

    expect(host.peer()).toBeUndefined();
    expect(stateOf(host)).toBe("waiting");
    expect(left).toEqual(["controller-1"]);
  });

  it("rejects a duplicate host with room-conflict and leaves the existing host in place", async () => {
    const server = createServer();
    const timers = createManualTimers();
    const first = createSession(server.connect(), "host", "host-1", timers);
    const second = createSession(server.connect(), "host", "host-2", timers);

    await first.join();
    const joining = second.join();
    await flushFakeSignaling();

    await expect(joining).rejects.toMatchObject({ code: "room-conflict" });
    expect(stateOf(second)).toBe("closed");
    expect(stateOf(first)).toBe("waiting");
  });

  it("rejects a duplicate controller with controller-busy", async () => {
    const server = createServer();
    const timers = createManualTimers();
    const first = createSession(server.connect(), "controller", "controller-1", timers);
    const second = createSession(server.connect(), "controller", "controller-2", timers);

    await first.join();
    const joining = second.join();
    await flushFakeSignaling();

    await expect(joining).rejects.toMatchObject({ code: "controller-busy" });
    expect(stateOf(second)).toBe("closed");
  });

  it("enforces host offer and controller answer direction before relaying ICE", async () => {
    const server = createServer();
    const timers = createManualTimers();
    const host = createSession(server.connect(), "host", "host-1", timers);
    const controller = createSession(server.connect(), "controller", "controller-1", timers);
    const offers: string[] = [];
    const answers: string[] = [];
    const hostCandidates: string[] = [];
    const controllerCandidates: string[] = [];
    controller.onOffer((sdp) => offers.push(sdp));
    host.onAnswer((sdp) => answers.push(sdp));
    host.onIceCandidate((candidate) => hostCandidates.push(candidate.candidate));
    controller.onIceCandidate((candidate) => controllerCandidates.push(candidate.candidate));

    await host.join();
    await controller.join();
    await flushFakeSignaling();

    expect(() => controller.sendAnswer("answer-1")).toThrow("offer not received");
    expect(() => controller.sendIceCandidate({ candidate: "controller-ice-0" })).toThrow(
      "send the answer before controller candidates",
    );
    expect(() => host.sendAnswer("answer-1")).toThrow("only the controller sends answers");

    host.sendOffer("offer-1");
    await flushFakeSignaling();
    expect(offers).toEqual(["offer-1"]);

    controller.sendAnswer("answer-1");
    await flushFakeSignaling();
    expect(answers).toEqual(["answer-1"]);

    host.sendIceCandidate({ candidate: "host-ice-1" });
    controller.sendIceCandidate({ candidate: "controller-ice-1" });
    await flushFakeSignaling();

    expect(hostCandidates).toEqual(["controller-ice-1"]);
    expect(controllerCandidates).toEqual(["host-ice-1"]);
  });

  it("times out when the room never acknowledges the join", async () => {
    const pair = createFakeSignalingPair();
    cleanups.push(() => pair.disconnect());
    const timers = createManualTimers();
    const session = createSession(pair.host, "host", "host-1", timers);

    const joining = session.join();
    await flushFakeSignaling();
    timers.fire();

    await expect(joining).rejects.toMatchObject({ code: "timeout" });
    expect(stateOf(session)).toBe("closed");
  });

  it("fails closed when the joined acknowledgement does not match the join", async () => {
    const pair = createFakeSignalingPair();
    cleanups.push(() => pair.disconnect());
    const timers = createManualTimers();
    const session = createSession(pair.host, "host", "host-1", timers);

    const joining = session.join();
    await flushFakeSignaling();
    pair.controller.send({
      type: "joined",
      roomId: "other-room",
      peerId: "host-1",
      role: "host",
      peers: [],
    } satisfies SignalingFrame);
    await flushFakeSignaling();

    await expect(joining).rejects.toMatchObject({ code: "invalid-frame" });
    expect(stateOf(session)).toBe("closed");
  });
});

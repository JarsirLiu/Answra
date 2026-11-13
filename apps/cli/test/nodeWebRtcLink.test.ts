import {
  RemoteSignalingSession,
  type RemoteSignalingTimers,
  type SignalingChannel,
} from "@answra/remote";
import { createFakeSignalingServer, flushFakeSignaling } from "@answra/remote/testing";
import type { RemoteFrame } from "@answra/shared/schema";
import { afterEach, describe, expect, it } from "vitest";
import { NodeWebRtcLink } from "../src/remote/transport/nodeWebRtcLink";

const realTimers: RemoteSignalingTimers = {
  after(delayMs, callback) {
    const id = setTimeout(callback, delayMs);
    return () => clearTimeout(id);
  },
};

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function createSession(channel: SignalingChannel, role: "host" | "controller", peerId: string) {
  const session = new RemoteSignalingSession({
    channel,
    roomId: "room-1",
    peerId,
    role,
    timers: realTimers,
  });
  cleanups.push(() => session.close());
  return session;
}

async function waitForOpen(...links: NodeWebRtcLink[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (links.every((link) => link.state() === "open")) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out opening links: ${links.map((link) => link.state()).join(", ")}`);
}

describe("NodeWebRtcLink", () => {
  it("opens a real loopback DataChannel through the signaling state machine", async () => {
    const server = createFakeSignalingServer();
    cleanups.push(() => server.disconnectAll());

    const hostSignaling = createSession(server.connect(), "host", "host-1");
    const controllerSignaling = createSession(server.connect(), "controller", "controller-1");

    await controllerSignaling.join();
    await hostSignaling.join();
    await flushFakeSignaling();
    await hostSignaling.waitForPeer();
    await controllerSignaling.waitForPeer();

    const hostLink = new NodeWebRtcLink({
      role: "host",
      signaling: hostSignaling,
    });
    const controllerLink = new NodeWebRtcLink({
      role: "controller",
      signaling: controllerSignaling,
    });
    cleanups.push(() => hostLink.close());
    cleanups.push(() => controllerLink.close());

    const received: RemoteFrame[] = [];
    controllerLink.onFrame((frame) => received.push(frame));

    await waitForOpen(hostLink, controllerLink);

    hostLink.send({
      type: "hello",
      protocolVersion: 1,
      role: "controller",
      sessionId: "session-1",
      peerId: "controller-1",
      capabilities: [],
    });

    const deadline = Date.now() + 5_000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(received).toEqual([
      {
        type: "hello",
        protocolVersion: 1,
        role: "controller",
        sessionId: "session-1",
        peerId: "controller-1",
        capabilities: [],
      },
    ]);
  }, 20_000);
});

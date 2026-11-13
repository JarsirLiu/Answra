import type { RemoteHello } from "@answra/shared/schema";
import { describe, expect, it } from "vitest";
import {
  createFakeAgentEvent,
  createFakeHostCommandPort,
  createFakeRemoteLinkPair,
  createFakeSignalingPair,
  flushFakeRemoteLink,
  flushFakeSignaling,
} from "../src/testing";

const hello: RemoteHello = {
  type: "hello",
  protocolVersion: 1,
  role: "controller",
  sessionId: "session-1",
  peerId: "controller-1",
  capabilities: ["coding"],
};

describe("fake remote link", () => {
  it("delivers frames to the peer and notifies state changes", async () => {
    const pair = createFakeRemoteLinkPair();
    const received: unknown[] = [];
    const states: string[] = [];
    pair.host.onFrame((frame) => received.push(frame));
    pair.host.onState((state) => states.push(state));

    pair.controller.send(hello);
    await flushFakeRemoteLink();
    expect(received).toEqual([hello]);

    pair.host.close();
    expect(states).toEqual(["closed"]);
    expect(pair.host.state()).toBe("closed");
    expect(() => pair.host.send(hello)).toThrow("remote-link-closed");
  });

  it("stops delivering after unsubscribe", async () => {
    const pair = createFakeRemoteLinkPair();
    const received: unknown[] = [];
    const unsubscribe = pair.controller.onFrame((frame) => received.push(frame));

    pair.host.send({ ...hello, role: "host" });
    await flushFakeRemoteLink();
    unsubscribe();
    pair.host.send({ ...hello, role: "host" });
    await flushFakeRemoteLink();

    expect(received).toHaveLength(1);
  });
});

describe("fake signaling channel", () => {
  it("exchanges room negotiation frames", async () => {
    const pair = createFakeSignalingPair();
    const received: unknown[] = [];
    pair.host.onFrame((frame) => received.push(frame));

    pair.controller.send({
      type: "join",
      roomId: "room-1",
      peerId: "controller-1",
      role: "controller",
      protocolVersion: 1,
    });
    await flushFakeSignaling();

    expect(received).toHaveLength(1);
    expect(pair.host.state()).toBe("open");
  });
});

describe("fake host command port", () => {
  it("exposes capabilities, model settings, commands and events", async () => {
    const host = createFakeHostCommandPort({ capabilities: ["coding", "model-settings"] });
    expect(host.capabilities()).toEqual(["coding", "model-settings"]);

    const view = await host.settings().addLocal({
      baseUrl: "http://127.0.0.1:1234/v1",
      chatModel: "local-model",
    });
    expect(view).toMatchObject({ source: "local", configured: true });

    const { runId } = await host.send({
      operation: "chat.send",
      conversationId: "conversation-1",
      request: { text: "hello", images: [] },
    });
    expect(runId).toBe("run-1");
    expect(host.sentCommands).toHaveLength(1);

    const event = createFakeAgentEvent(2);
    host.emitEvent(event);
    expect(await host.readEvents("conversation-1", 1)).toEqual([event]);
  });
});

import type {
  AgentEventEnvelope,
  ConversationSnapshot,
  RemoteWelcome,
} from "@answra/shared/schema";
import { describe, expect, it } from "vitest";
import { RemoteControllerSession, RemoteHostSession } from "../src";
import {
  createFakeAgentEvent,
  createFakeConversationSnapshot,
  createFakeHostCommandPort,
  createFakeModelConfig,
  createFakeRemoteLinkPair,
  flushFakeRemoteLink,
} from "../src/testing";

function createSessions() {
  const hostPort = createFakeHostCommandPort();
  const link = createFakeRemoteLinkPair();
  const host = new RemoteHostSession({
    host: hostPort,
    link: link.host,
    hostId: "host-1",
    workspaceRoot: "D:/workspace",
  });
  const controller = new RemoteControllerSession({
    link: link.controller,
    sessionId: "session-1",
    peerId: "controller-1",
  });
  return { controller, host, hostPort, link };
}

function chatSend(conversationId: string) {
  return {
    operation: "chat.send" as const,
    conversationId,
    request: { text: "hello", images: [] },
  };
}

describe("remote host/controller sessions", () => {
  it("handshakes and exposes host capabilities and model settings", async () => {
    const { controller, host, link } = createSessions();

    const welcome: RemoteWelcome = await controller.connect();

    expect(welcome).toMatchObject({
      type: "welcome",
      protocolVersion: 1,
      sessionId: "session-1",
      hostId: "host-1",
      workspaceRoot: "D:/workspace",
      capabilities: ["coding", "model-settings"],
    });
    expect(welcome.leaseId).toMatch(/^lease-/);
    expect(welcome.modelSettings?.chatModel).toBe("local-model");
    expect(controller.state()).toBe("ready");
    expect(controller.capabilities()).toEqual(["coding", "model-settings"]);

    controller.close();
    host.close();
    link.disconnect();
  });

  it("routes conversation, send, cancel and bot commands to the host port", async () => {
    const { controller, host, hostPort, link } = createSessions();
    await controller.connect();

    const created = await controller.createConversation("conversation-2");
    expect(created).toMatchObject({ conversationId: "conversation-2", messages: [] });

    const { runId } = await controller.send(chatSend("conversation-2"));
    expect(runId).toBe("run-1");
    expect(hostPort.sentCommands).toEqual([chatSend("conversation-2")]);

    await controller.cancel(runId);
    expect(hostPort.cancelledRunIds).toEqual(["run-1"]);

    const cleared = await controller.clearConversation("conversation-2");
    expect(cleared.messages).toEqual([]);

    const snapshot = await controller.snapshot("conversation-2");
    expect(snapshot.conversationId).toBe("conversation-2");

    const bots = await controller.listBots();
    expect(bots[0]?.id).toBe("coding.engineer");

    await controller.selectBot("conversation-2", "coding.engineer");

    controller.close();
    host.close();
    link.disconnect();
  });

  it("maps model settings and model application to the host", async () => {
    const { controller, host, hostPort, link } = createSessions();
    await controller.connect();

    expect((await controller.settings().snapshot()).configured).toBe(true);

    const added = await controller.settings().addLocal({
      baseUrl: "http://127.0.0.1:4321/v1",
      chatModel: "new-model",
    });
    expect(added).toMatchObject({
      source: "local",
      baseUrl: "http://127.0.0.1:4321/v1",
      chatModel: "new-model",
      configured: true,
    });

    expect((await controller.settings().switchChatModel("next-model")).chatModel).toBe(
      "next-model",
    );
    expect((await controller.settings().clearLocal()).configured).toBe(false);

    await controller.applyModel(createFakeModelConfig());
    expect(hostPort.appliedModels).toHaveLength(1);

    controller.close();
    host.close();
    link.disconnect();
  });

  it("streams host snapshots and events after welcome", async () => {
    const { controller, host, hostPort, link } = createSessions();
    await controller.connect();

    const snapshots: ConversationSnapshot[] = [];
    const events: AgentEventEnvelope[] = [];
    controller.onSnapshot((snapshot) => snapshots.push(snapshot));
    controller.onEvent((event) => events.push(event));

    hostPort.emitSnapshot(
      createFakeConversationSnapshot({
        conversationId: "conversation-live",
        eventRevision: 3,
      }),
    );
    hostPort.emitEvent(createFakeAgentEvent(4));
    await flushFakeRemoteLink();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.conversationId).toBe("conversation-live");
    expect(snapshots[0]?.eventRevision).toBe(3);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventId).toBe("event-4");

    controller.close();
    host.close();
    link.disconnect();
  });

  it("rejects commands after the controller closes", async () => {
    const { controller, host, link } = createSessions();
    await controller.connect();

    controller.close();

    expect(controller.state()).toBe("closed");
    await expect(controller.snapshot("conversation-1")).rejects.toMatchObject({
      code: "remote-disconnected",
    });

    host.close();
    link.disconnect();
  });

  it("returns a stable command error when the host command fails", async () => {
    const { controller, host, hostPort, link } = createSessions();
    hostPort.send = async () => {
      throw new Error("host failure");
    };
    await controller.connect();

    await expect(controller.send(chatSend("conversation-1"))).rejects.toMatchObject({
      code: "internal",
    });

    controller.close();
    host.close();
    link.disconnect();
  });
});

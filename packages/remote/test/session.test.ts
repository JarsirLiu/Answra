import type {
  AgentEventEnvelope,
  ConversationSnapshot,
  RemoteWelcome,
} from "@answra/shared/schema";
import { describe, expect, it } from "vitest";
import {
  createRemoteCredentialRecord,
  createRemoteHostAccessKeyRecord,
  generateRemoteAccessKey,
  RemoteControllerSession,
  RemoteHostSession,
} from "../src";
import {
  createFakeAgentEvent,
  createFakeConversationSnapshot,
  createFakeHostCommandPort,
  createFakeModelConfig,
  createFakeRemoteLinkPair,
  createMemoryHostKeyStore,
  flushFakeRemoteLink,
} from "../src/testing";

const NOW = new Date("2026-11-13T00:00:00.000Z");

async function createSessions(
  options: { credentialKey?: string; hostNow?: Date; revokedAt?: string } = {},
) {
  const generated = generateRemoteAccessKey({ now: NOW });
  const record = {
    ...(await createRemoteHostAccessKeyRecord(generated)),
    ...(options.revokedAt === undefined ? {} : { revokedAt: options.revokedAt }),
  };
  const credential = createRemoteCredentialRecord(options.credentialKey ?? generated.key, {
    savedAt: NOW,
  });
  const hostPort = createFakeHostCommandPort();
  const link = createFakeRemoteLinkPair();
  const host = new RemoteHostSession({
    host: hostPort,
    link: link.host,
    hostKeys: createMemoryHostKeyStore([record]),
    hostId: "host-1",
    workspaceRoot: "D:/workspace",
    now: () => options.hostNow ?? NOW,
  });
  const controller = new RemoteControllerSession({
    link: link.controller,
    sessionId: "session-1",
    peerId: "controller-1",
    credential,
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
    const { controller, host, link } = await createSessions();

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
    const { controller, host, hostPort, link } = await createSessions();
    await controller.connect();

    const created = await controller.createConversation("conversation-2");
    expect(created).toMatchObject({ conversationId: "conversation-2", messages: [] });

    const result = await controller.send(chatSend("conversation-2"));
    expect(result).toMatchObject({ status: "started", turnId: "turn-1", position: 0 });
    expect(hostPort.sentCommands).toEqual([chatSend("conversation-2")]);

    if (result.status !== "started") throw new Error("expected started result");
    await controller.cancel("conversation-2", result.turnId);
    expect(hostPort.cancelledTurnIds).toEqual(["turn-1"]);
    expect(hostPort.cancelledConversationIds).toEqual(["conversation-2"]);

    const cleared = await controller.clearConversation("conversation-2");
    expect(cleared.messages).toEqual([]);

    const snapshot = await controller.snapshot("conversation-2");
    expect(snapshot.conversationId).toBe("conversation-2");

    const sessions = await controller.listSessions({ limit: 50 });
    expect(sessions.items[0]).toMatchObject({
      conversationId: "conversation-1",
      scope: "conversation",
    });

    const bots = await controller.listBots();
    expect(bots[0]?.id).toBe("coding.engineer");

    await controller.selectBot("conversation-2", "coding.engineer");

    controller.close();
    host.close();
    link.disconnect();
  });

  it("maps model settings and model application to the host", async () => {
    const { controller, host, hostPort, link } = await createSessions();
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
    const { controller, host, hostPort, link } = await createSessions();
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

  it("rejects session list when the host does not expose history", async () => {
    const { controller, host, hostPort, link } = await createSessions();
    delete hostPort.listSessions;
    await controller.connect();

    await expect(controller.listSessions()).rejects.toMatchObject({
      code: "invalid-command",
    });

    controller.close();
    host.close();
    link.disconnect();
  });

  it("rejects commands after the controller closes", async () => {
    const { controller, host, link } = await createSessions();
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
    const { controller, host, hostPort, link } = await createSessions();
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

  it("does not route commands before authentication", async () => {
    const { host, hostPort, link } = await createSessions();

    link.controller.send({
      type: "hello",
      protocolVersion: 1,
      role: "controller",
      sessionId: "session-1",
      peerId: "controller-1",
      capabilities: ["coding"],
    });
    link.controller.send({
      type: "command",
      requestId: "request-1",
      command: { type: "send", command: chatSend("conversation-1") },
    });
    await flushFakeRemoteLink();

    expect(hostPort.sentCommands).toEqual([]);
    host.close();
    link.disconnect();
  });

  it("rejects a wrong key before sending welcome", async () => {
    const wrongKey = generateRemoteAccessKey({ now: NOW }).key;
    const { controller, host, link } = await createSessions({ credentialKey: wrongKey });

    await expect(controller.connect()).rejects.toMatchObject({ code: "unauthorized" });
    expect(controller.state()).toBe("closed");

    host.close();
    link.disconnect();
  });

  it("rejects revoked and expired keys with stable codes", async () => {
    const revoked = await createSessions({ revokedAt: NOW.toISOString() });
    await expect(revoked.controller.connect()).rejects.toMatchObject({ code: "key-revoked" });
    revoked.host.close();
    revoked.link.disconnect();

    const expired = await createSessions({
      hostNow: new Date("2026-11-21T00:00:00.000Z"),
    });
    await expect(expired.controller.connect()).rejects.toMatchObject({ code: "key-expired" });
    expired.host.close();
    expired.link.disconnect();
  });
});

import {
  createRemoteCredentialRecord,
  createRemoteHostAccessKeyRecord,
  generateRemoteAccessKey,
  RemoteControllerSession,
  RemoteHostSession,
} from "@answra/remote";
import {
  createFakeAgentEvent,
  createFakeHostCommandPort,
  createFakeRemoteLinkPair,
  createMemoryHostKeyStore,
  flushFakeRemoteLink,
} from "@answra/remote/testing";
import type { AgentEventEnvelope } from "@answra/shared/schema";
import { describe, expect, it } from "vitest";
import { createRemoteModelSettings } from "../../../src/remote/controller/modelSettings";
import { createRemoteControllerSessionHost } from "../../../src/remote/controller/sessionHost";

const NOW = new Date("2026-11-13T00:00:00.000Z");
const MODEL = {
  chat: { baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", auth: "local" as const },
  answer: { baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", auth: "local" as const },
};

async function createSessions() {
  const generated = generateRemoteAccessKey({ now: NOW });
  const record = await createRemoteHostAccessKeyRecord(generated);
  const credential = createRemoteCredentialRecord(generated.key, { savedAt: NOW });
  const hostPort = createFakeHostCommandPort();
  const link = createFakeRemoteLinkPair();
  const host = new RemoteHostSession({
    host: hostPort,
    link: link.host,
    hostKeys: createMemoryHostKeyStore([record]),
    hostId: "host-1",
    workspaceRoot: "D:/workspace",
    now: () => NOW,
  });
  const controller = new RemoteControllerSession({
    link: link.controller,
    sessionId: "session-1",
    peerId: "controller-1",
    credential,
  });
  await controller.connect();
  return { controller, host, hostPort, link };
}

function terminalEvent(runId: string): AgentEventEnvelope {
  return {
    ...createFakeAgentEvent(2),
    conversationId: "conversation-1",
    runId,
    event: { type: "run-state-changed", state: "completed", attempt: 1 },
  };
}

describe("remote CLI controller adapter", () => {
  it("drives the host through CodingSessionHost and waits for terminal run events", async () => {
    const { controller, host, hostPort, link } = await createSessions();
    const events: AgentEventEnvelope[] = [];
    const snapshots: string[] = [];
    const sessionHost = createRemoteControllerSessionHost({
      session: controller,
      emitEvent: (event) => events.push(event),
      onSnapshot: (snapshot) => snapshots.push(snapshot.conversationId),
    });

    sessionHost.configure(MODEL);
    await sessionHost.createConversation("conversation-1");
    expect(hostPort.appliedModels).toHaveLength(1);

    const { runId } = await sessionHost.send(
      "conversation-1",
      { text: "hello", images: [] },
      "ignored-controller-token",
    );
    expect(runId).toBe("run-1");
    expect(hostPort.sentCommands).toEqual([
      {
        operation: "chat.send",
        conversationId: "conversation-1",
        request: { text: "hello", images: [] },
      },
    ]);

    const waiting = sessionHost.waitForRun(runId);
    hostPort.emitEvent(terminalEvent(runId));
    await flushFakeRemoteLink();
    await waiting;
    expect(events).toHaveLength(1);

    hostPort.emitSnapshot({ conversationId: "conversation-1", eventRevision: 2, messages: [] });
    await flushFakeRemoteLink();
    expect(snapshots).toEqual(["conversation-1"]);

    sessionHost.cancel("run-2");
    await flushFakeRemoteLink();
    expect(hostPort.cancelledRunIds).toEqual(["run-2"]);

    sessionHost.dispose();
    expect(controller.state()).toBe("closed");
    host.close();
    link.disconnect();
  });

  it("maps remote model settings without reading controller-local config", async () => {
    const { controller, host, link } = await createSessions();
    const settings = createRemoteModelSettings(controller.settings());

    expect((await settings.resolve([])).chat.model).toBe("local-model");
    expect((await settings.snapshot()).configured).toBe(true);

    const added = await settings.addLocal({
      baseUrl: "http://127.0.0.1:4321/v1",
      chatModel: "next-model",
    });
    expect(added.chat.model).toBe("next-model");
    expect((await settings.snapshot()).local.baseUrl).toBe("http://127.0.0.1:4321/v1");

    await settings.clearLocal();
    expect((await settings.snapshot()).configured).toBe(false);

    controller.close();
    host.close();
    link.disconnect();
  });
});

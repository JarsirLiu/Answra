import { RemoteOperationError } from "@answra/remote";
import type {
  AgentEventEnvelope,
  ConversationSessionPage,
  ConversationSnapshot,
  RemoteModelConfig,
} from "@answra/shared/schema";
import { describe, expect, it } from "vitest";
import type {
  DesktopRemoteAgentPort,
  DesktopRemoteQueueStart,
  DesktopRemoteSessionQuery,
} from "../src/main/remote/host/agentPort";
import { createDesktopRemoteCommandPort } from "../src/main/remote/host/commandPort";

const createdAt = "2026-11-21T00:00:00.000Z";

function snapshot(conversationId: string): ConversationSnapshot {
  return { conversationId, eventRevision: 0, messages: [] };
}

function event(conversationId: string, sequence = 1): AgentEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    conversationId,
    runId: "run-1",
    attemptId: "attempt-1",
    sequence,
    aggregateRevision: sequence,
    producerId: "desktop",
    occurredAt: createdAt,
    event: { type: "text-delta", partId: "part-1", delta: "hello" },
  };
}

function sessionPage(conversationIds: readonly string[]): ConversationSessionPage {
  return {
    items: conversationIds.map((conversationId, index) => ({
      conversationId,
      scope: "conversation",
      title: `Session ${index + 1}`,
      messageCount: 1,
      createdAt,
      updatedAt: createdAt,
    })),
  };
}

function createAgent(conversationIds: readonly string[] = ["conversation-1"]) {
  const snapshotListeners = new Set<(value: ConversationSnapshot) => void>();
  const eventListeners = new Set<(value: AgentEventEnvelope) => void>();
  const listQueries: Array<DesktopRemoteSessionQuery | undefined> = [];
  const sentConversationIds: string[] = [];
  const page = sessionPage(conversationIds);

  const agent: DesktopRemoteAgentPort = {
    async listConversationSessions(query) {
      listQueries.push(query);
      return page;
    },
    async createConversation(conversationId) {
      return snapshot(conversationId);
    },
    async clearConversation(conversationId) {
      return snapshot(conversationId);
    },
    async getSnapshot(conversationId) {
      return snapshot(conversationId);
    },
    async readEvents(conversationId) {
      return [event(conversationId)];
    },
    async send(command) {
      sentConversationIds.push(command.conversationId);
      return {
        queueId: "queue-1",
        status: "started",
        position: 0,
        runId: "run-1",
        snapshot: snapshot(command.conversationId),
      };
    },
    async waitForConversationQueue(_conversationId, queueId) {
      return { queueId, runId: "run-1", outcome: "completed" };
    },
    async waitForConversationQueueStart(
      conversationId: string,
      queueId: string,
    ): Promise<DesktopRemoteQueueStart> {
      return { queueId, runId: "run-1", snapshot: snapshot(conversationId) };
    },
    cancel() {},
    onSnapshot(listener) {
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  };

  return {
    agent,
    listQueries,
    sentConversationIds,
    emitSnapshot(value: ConversationSnapshot) {
      for (const listener of snapshotListeners) listener(value);
    },
    emitEvent(value: AgentEventEnvelope) {
      for (const listener of eventListeners) listener(value);
    },
  };
}

describe("desktop remote command port", () => {
  it("declares only conversation capabilities and rejects remote model settings", async () => {
    const port = createDesktopRemoteCommandPort(createAgent().agent);

    expect(port.capabilities()).toEqual(["conversation", "sessions"]);
    await expect(port.settings().snapshot()).rejects.toMatchObject({
      code: "invalid-command",
    });
    expect(() =>
      port.applyModel({
        chat: { baseUrl: "http://127.0.0.1/v1", model: "chat" },
        answer: { baseUrl: "http://127.0.0.1/v1", model: "answer" },
      } satisfies RemoteModelConfig),
    ).toThrow(RemoteOperationError);
  });

  it("forces the conversation scope when listing history", async () => {
    const harness = createAgent(["conversation-1", "conversation-2"]);
    const port = createDesktopRemoteCommandPort(harness.agent);

    const page = await port.listSessions?.({ limit: 10 });

    expect(harness.listQueries).toEqual([{ scope: "conversation", limit: 10 }]);
    expect(page?.items.map((item) => item.conversationId)).toEqual([
      "conversation-1",
      "conversation-2",
    ]);
  });

  it("rejects conversations that were not listed or created remotely", async () => {
    const port = createDesktopRemoteCommandPort(createAgent().agent);

    await expect(port.snapshot("interview-1")).rejects.toMatchObject({ code: "not-found" });
    await expect(port.readEvents("interview-1", 0)).rejects.toMatchObject({ code: "not-found" });
    await expect(port.clearConversation("interview-1")).rejects.toMatchObject({
      code: "not-found",
    });
    await expect(
      port.send({
        operation: "chat.send",
        conversationId: "interview-1",
        request: { text: "hello", images: [] },
      }),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("adds listed and created conversations to the visible set", async () => {
    const harness = createAgent();
    const port = createDesktopRemoteCommandPort(harness.agent);

    await port.listSessions?.();
    await expect(port.snapshot("conversation-1")).resolves.toMatchObject({
      conversationId: "conversation-1",
    });
    await expect(
      port.send({
        operation: "chat.send",
        conversationId: "conversation-1",
        request: { text: "hello", images: [] },
      }),
    ).resolves.toMatchObject({ status: "started", runId: "run-1" });
    expect(harness.sentConversationIds).toEqual(["conversation-1"]);

    const created = await port.createConversation("conversation-2", {
      kind: "bot",
      botId: "conversation.general",
    });
    expect(created.conversationId).toBe("conversation-2");
    await expect(port.snapshot("conversation-2")).resolves.toMatchObject({
      conversationId: "conversation-2",
    });
  });

  it("rejects team creation and team sends while the team capability is not declared", async () => {
    const port = createDesktopRemoteCommandPort(createAgent().agent);

    await expect(
      port.createConversation("conversation-2", { kind: "team", teamId: "team-1" }),
    ).rejects.toMatchObject({ code: "invalid-command" });

    await port.listSessions?.();
    await expect(
      port.send({
        operation: "team.send",
        conversationId: "conversation-1",
        teamId: "team-1",
        request: { text: "hello", images: [] },
      }),
    ).rejects.toMatchObject({ code: "invalid-command" });
  });

  it("forwards queue waits only for visible conversations", async () => {
    const port = createDesktopRemoteCommandPort(createAgent().agent);

    await expect(port.waitQueueStart("conversation-1", "queue-1")).rejects.toMatchObject({
      code: "not-found",
    });

    await port.listSessions?.();
    await expect(port.waitQueueStart("conversation-1", "queue-1")).resolves.toMatchObject({
      queueId: "queue-1",
      runId: "run-1",
      snapshot: { conversationId: "conversation-1" },
    });
  });

  it("rejects cancel for conversations that were not listed or created remotely", async () => {
    const port = createDesktopRemoteCommandPort(createAgent().agent);

    expect(() => port.cancel("interview-1", "run-1")).toThrow(RemoteOperationError);

    await port.listSessions?.();
    expect(() => port.cancel("conversation-1", "run-1")).not.toThrow();
  });

  it("filters snapshots and events to visible conversations", async () => {
    const harness = createAgent(["conversation-1"]);
    const port = createDesktopRemoteCommandPort(harness.agent);
    const snapshots: string[] = [];
    const events: string[] = [];
    port.onSnapshot((value) => snapshots.push(value.conversationId));
    port.onEvent((value) => events.push(value.conversationId));

    harness.emitSnapshot(snapshot("conversation-1"));
    harness.emitSnapshot(snapshot("interview-1"));
    harness.emitEvent(event("conversation-1"));
    harness.emitEvent(event("interview-1"));

    expect(snapshots).toEqual([]);
    expect(events).toEqual([]);

    await port.listSessions?.();
    harness.emitSnapshot(snapshot("conversation-1"));
    harness.emitSnapshot(snapshot("interview-1"));
    harness.emitEvent(event("conversation-1"));
    harness.emitEvent(event("interview-1"));

    expect(snapshots).toEqual(["conversation-1"]);
    expect(events).toEqual(["conversation-1"]);
  });
});

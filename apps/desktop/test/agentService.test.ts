import { EventEmitter } from "node:events";
import type { AgentCommand, AgentFrame } from "@answra/agent";
import type { ConversationSnapshot } from "@answra/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  workers: [] as unknown[],
}));

class FakeWorker extends EventEmitter {
  readonly pid = 1;
  readonly stdout = undefined;
  readonly stderr = undefined;
  readonly postMessage = vi.fn((command: AgentCommand) => {
    const reply = (value?: unknown) => {
      queueMicrotask(() => {
        this.emit("message", {
          version: 1,
          type: "response",
          id: command.id,
          ok: true,
          ...(value === undefined ? {} : { value }),
        } satisfies AgentFrame);
      });
    };
    if (command.type === "snapshot" || command.type === "create-conversation") {
      reply(emptySnapshot(command.conversationId));
      return;
    }
    reply();
  });
  readonly kill = vi.fn(() => {
    this.emit("exit", 0);
  });
}

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "C:/app",
    getPath: () => "C:/data",
    isPackaged: false,
  },
  utilityProcess: {
    fork: () => {
      const worker = new FakeWorker();
      shared.workers.push(worker);
      return worker;
    },
  },
}));

import { AgentService } from "../src/main/agent/agentService";

const emptySnapshot = (conversationId: string): ConversationSnapshot => ({
  conversationId,
  eventRevision: 0,
  messages: [],
});

function lastWorker(): FakeWorker {
  const worker = shared.workers.at(-1);
  if (!(worker instanceof FakeWorker)) throw new Error("worker was not created");
  return worker;
}

function createService(): AgentService {
  return new AgentService({
    resolveModel: async () => ({
      config: {
        chat: { baseUrl: "http://127.0.0.1/v1", model: "chat" },
        answer: { baseUrl: "http://127.0.0.1/v1", model: "chat" },
      },
      accessToken: "",
    }),
    getWorkspaceRoot: () => null,
    getInterviewDataRoot: () => "C:/data/interview",
  });
}

describe("AgentService connection lifecycle", () => {
  beforeEach(() => {
    shared.workers.length = 0;
  });

  it("connects through the readiness ping and restarts after an unexpected exit", async () => {
    const service = createService();
    await service.start();

    expect(service.getConnectionState()).toMatchObject({
      status: "connected",
      attempt: 1,
    });
    expect(shared.workers).toHaveLength(1);
    expect(lastWorker().postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ping" }),
    );

    lastWorker().emit("exit", 7);

    await vi.waitFor(() => {
      expect(service.getConnectionState().status).toBe("connected");
    });
    expect(shared.workers).toHaveLength(2);
    await service.stop();
  });

  it("refreshes known conversation snapshots after a worker restart", async () => {
    const service = createService();
    await service.start();
    await service.createConversation("conversation-1");
    const snapshots: ConversationSnapshot[] = [];
    service.onSnapshot((snapshot) => snapshots.push(snapshot));

    lastWorker().emit("exit", 1);

    await vi.waitFor(() => {
      expect(snapshots).toContainEqual(emptySnapshot("conversation-1"));
    });
    await service.stop();
  });

  it("re-sends model configuration to the replacement worker", async () => {
    const service = createService();
    await service.start();
    await service.send({
      operation: "chat.send",
      profileId: "general-chat",
      conversationId: "conversation-1",
      request: { text: "hello", images: [] },
    });
    expect(lastWorker().postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "configure" }),
    );

    lastWorker().emit("exit", 1);
    await vi.waitFor(() => expect(service.getConnectionState().status).toBe("connected"));
    const replacement = lastWorker();

    await service.send({
      operation: "chat.send",
      profileId: "general-chat",
      conversationId: "conversation-2",
      request: { text: "again", images: [] },
    });
    expect(replacement.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "configure" }),
    );
    await service.stop();
  });
});

/** Session 底座接入 ConversationApplication 后的 UI 事件与断点恢复集成测试。 */
import type { AgentEventEnvelope } from "@answra/shared/schema";
import { describe, expect, it, vi } from "vitest";
import { ConversationApplication } from "../../src/conversation/application";
import type { ConversationBot } from "../../src/conversation/bots/types";
import { CHAT_PROFILES } from "../../src/conversation/profiles/registry";
import { agentId } from "../../src/core/agent/definition";
import type { AgentRuntime } from "../../src/core/agent/runtime";
import { createBotCatalog } from "../../src/core/bot/catalog";
import type { StepRunner } from "../../src/core/session/contracts";
import { sessionId, stepId, turnId } from "../../src/core/session/contracts";
import { MemorySessionJournal } from "../../src/core/session/memoryJournal";
import { MemoryConversationStore } from "../../src/core/transcript/memoryStore";
import { createUserMessage } from "../../src/core/transcript/message";
import { MemoryExecutionStore } from "../../src/execution/memoryStore";

const general = agentId("conversation.general");

function fakeRuntime(): AgentRuntime {
  return {
    assertRegistered: vi.fn(),
    assertTeamMembers: vi.fn(),
    dispose: vi.fn(),
    cancel: vi.fn(),
    waitForRun: vi.fn(async () => undefined),
    getRun: vi.fn(async () => undefined),
    readEventsForRun: vi.fn(async () => []),
    activeRunCount: 0,
    chatContextWindow: () => undefined,
    chatEndpoint: () => ({ baseUrl: "http://127.0.0.1:1/v1", model: "test" }),
  } as unknown as AgentRuntime;
}

function makeBot(): ConversationBot {
  return {
    id: general,
    identity: { name: "助手", role: "general", responsibility: "通用", owns: ["conversation"] },
    discovery: { visibleTo: { kind: "team", teamId: "conversation" } },
    domain: "conversation",
    executor: {
      startRun: async () => {
        throw new Error("Session 底座不应调用 startRun");
      },
      prepare: async () => {
        throw new Error("测试 StepRunner 不准备模型请求");
      },
    },
    policy: CHAT_PROFILES["general-chat"],
  };
}

function makeApp({
  store,
  journal,
  events,
  runner,
}: {
  store: MemoryConversationStore;
  journal: MemorySessionJournal;
  events: MemoryExecutionStore;
  runner: StepRunner;
}): ConversationApplication {
  return new ConversationApplication({
    agentRuntime: fakeRuntime(),
    store,
    catalog: createBotCatalog([makeBot()]),
    sessionJournal: journal,
    executionStore: events,
    stepRunner: runner,
    onSnapshot: () => undefined,
  });
}

describe("ConversationApplication session integration", () => {
  it("projects live deltas and durable events into one monotonic UI revision stream", async () => {
    const store = new MemoryConversationStore();
    const journal = new MemorySessionJournal();
    const events = new MemoryExecutionStore();
    const emitted: AgentEventEnvelope[] = [];
    events.subscribe((event) => emitted.push(event));
    const runner: StepRunner = {
      async run(_step, context) {
        await context.events.append({ type: "text-start", partId: "text" });
        await context.events.append({ type: "text-delta", partId: "text", delta: "你好" });
        await context.events.append({ type: "text-delta", partId: "text", delta: "世界" });
        await context.events.append({ type: "text-end", partId: "text" });
        return { outcome: "completed", finishReason: "stop" };
      },
    };
    const app = makeApp({ store, journal, events, runner });

    const result = await app.send(
      undefined,
      "ui-conversation",
      { text: "你好", images: [] },
      "token",
    );
    for (
      let attempt = 0;
      attempt < 200 &&
      emitted.every(
        (event) => event.event.type !== "run-state-changed" || event.event.state !== "completed",
      );
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const replayed = await app.readEventsAfter("ui-conversation", 0);

    expect(result.runId).toBeTruthy();
    const revisions = emitted.map((event) => event.aggregateRevision);
    expect(revisions).toEqual(revisions.map((_, index) => index + 1));
    expect(emitted.filter((event) => event.event.type === "text-delta")).toHaveLength(2);
    expect(emitted.filter((event) => event.event.type === "text-start")).toHaveLength(1);
    expect(emitted.filter((event) => event.event.type === "text-end")).toHaveLength(1);
    expect(emitted.every((event) => event.conversationId === "ui-conversation")).toBe(true);
    const terminal = emitted.find(
      (event) =>
        event.event.type === "run-state-changed" &&
        event.runId === result.runId &&
        event.event.state === "completed",
    );
    expect(terminal).toBeDefined();
    expect(replayed.map((event) => event.aggregateRevision)).toEqual(revisions);
  });

  it("closes the interrupted assistant message on startup recovery", async () => {
    const store = new MemoryConversationStore();
    const journal = new MemorySessionJournal();
    const events = new MemoryExecutionStore();
    const conversationId = "recovered-conversation";
    const id = sessionId(conversationId);
    await store.create(conversationId);
    const user = createUserMessage("user-1", { text: "你好", images: [] });
    await store.beginSessionTurn(conversationId, {
      turnId: "turn-1",
      messageId: "assistant-1",
      authorAgentId: general,
      userMessage: user,
    });
    await journal.append(
      id,
      { type: "turn-queued", source: "user", agentId: general, input: user },
      { turnId: turnId("turn-1") },
    );
    await journal.append(
      id,
      { type: "turn-started", agentId: general },
      { turnId: turnId("turn-1"), messageId: "assistant-1" },
    );
    await journal.append(
      id,
      { type: "step-started", stepId: "step-1", index: 0, agentId: general },
      { turnId: turnId("turn-1"), stepId: stepId("step-1"), messageId: "assistant-1" },
    );

    const app = makeApp({
      store,
      journal,
      events,
      runner: { run: async () => ({ outcome: "aborted" }) },
    });
    const snapshot = await app.getSnapshot(conversationId);

    expect(snapshot.activeRunId).toBeUndefined();
    expect(snapshot.messages.map((message) => message.status)).toEqual(["complete", "interrupted"]);
    await expect(
      app.send(undefined, conversationId, { text: "继续", images: [] }, "token"),
    ).resolves.toBeDefined();
  });
});

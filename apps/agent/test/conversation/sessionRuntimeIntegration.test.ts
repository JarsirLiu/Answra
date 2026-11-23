/** Session 底座接入 ConversationApplication 后的帧广播与断点恢复集成测试。 */
import type { LiveFrame, SessionFrame } from "@answra/shared/schema";
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
import { SessionFrameBus } from "../../src/core/session/sessionFrameBus";
import { MemoryConversationStore } from "../../src/core/transcript/memoryStore";
import { createUserMessage } from "../../src/core/transcript/message";

const general = agentId("conversation.general");

function fakeRuntime(): AgentRuntime {
  return {
    assertRegistered: vi.fn(),
    assertTeamMembers: vi.fn(),
    dispose: vi.fn(),
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
  sessionFrames,
  runner,
}: {
  store: MemoryConversationStore;
  journal: MemorySessionJournal;
  sessionFrames?: SessionFrameBus;
  runner: StepRunner;
}): ConversationApplication {
  return new ConversationApplication({
    agentRuntime: fakeRuntime(),
    store,
    catalog: createBotCatalog([makeBot()]),
    sessionJournal: journal,
    ...(sessionFrames === undefined ? {} : { sessionFrames }),
    stepRunner: runner,
    onSnapshot: () => undefined,
  });
}

describe("ConversationApplication session integration", () => {
  it("broadcasts live deltas and durable facts as frames with one monotonic seq", async () => {
    const store = new MemoryConversationStore();
    const journal = new MemorySessionJournal();
    const sessionFrames = new SessionFrameBus();
    const frames: SessionFrame[] = [];
    const live: LiveFrame[] = [];
    sessionFrames.subscribe({
      onFrame: (frame) => frames.push(frame),
      onLiveFrame: (frame) => live.push(frame),
    });
    const runner: StepRunner = {
      async run(_step, context) {
        await context.events.append({ type: "text-start", partId: "text" });
        await context.events.append({ type: "text-delta", partId: "text", delta: "你好" });
        await context.events.append({ type: "text-delta", partId: "text", delta: "世界" });
        await context.events.append({ type: "text-end", partId: "text" });
        return { outcome: "completed", finishReason: "stop" };
      },
    };
    const app = makeApp({ store, journal, sessionFrames, runner });

    const result = await app.send(
      undefined,
      "ui-conversation",
      { text: "你好", images: [] },
      "token",
    );
    await app.waitForTurn("ui-conversation", result.turnId);

    // durable 帧的 seq 由 journal 单调分配，客户端据此补齐缺口。
    expect(frames.map((frame) => frame.seq)).toEqual(frames.map((_, index) => index + 1));
    // 增量只走 live 通道，不进入 durable 序列。
    expect(live.filter((frame) => frame.event.type === "text-delta")).toHaveLength(2);
    expect(frames.filter((frame) => frame.event.type === "text-start")).toHaveLength(1);
    expect(frames.filter((frame) => frame.event.type === "text-end")).toHaveLength(1);
    expect(frames.every((frame) => frame.sessionId === "ui-conversation")).toBe(true);

    const messageId = result.snapshot.activeMessageId;
    expect(messageId).toBeDefined();
    expect(live.every((frame) => frame.messageId === messageId)).toBe(true);
    const terminal = frames.find(
      (frame) =>
        frame.event.type === "turn-finished" &&
        frame.turnId === result.turnId &&
        frame.event.status === "completed",
    );
    expect(terminal).toBeDefined();

    const replayed = await app.readFramesAfter("ui-conversation", 0);
    expect(replayed.map((frame) => frame.seq)).toEqual(frames.map((frame) => frame.seq));
  });

  it("closes the interrupted assistant message on startup recovery", async () => {
    const store = new MemoryConversationStore();
    const journal = new MemorySessionJournal();
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
      runner: { run: async () => ({ outcome: "aborted" }) },
    });
    const snapshot = await app.getSnapshot(conversationId);

    expect(snapshot.activeMessageId).toBeUndefined();
    expect(snapshot.messages.map((message) => message.status)).toEqual(["complete", "interrupted"]);
    await expect(
      app.send(undefined, conversationId, { text: "继续", images: [] }, "token"),
    ).resolves.toBeDefined();
  });
});

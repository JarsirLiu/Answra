/** Session 底座接入 ConversationApplication 后的帧广播与断点恢复集成测试。 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LiveFrame, SessionFrame } from "@answra/shared/schema";
import { describe, expect, it, vi } from "vitest";
import { ConversationApplication } from "../../src/conversation/application";
import type { ConversationBot } from "../../src/conversation/bots/types";
import { CHAT_PROFILES } from "../../src/conversation/profiles/registry";
import { agentId } from "../../src/core/agent/definition";
import type { AgentRuntime } from "../../src/core/agent/runtime";
import { createBotCatalog } from "../../src/core/bot/catalog";
import type { StepRunner } from "../../src/core/session/contracts";
import { sessionId } from "../../src/core/session/contracts";
import { SessionFrameBus } from "../../src/core/session/sessionFrameBus";
import type { SessionItemStore } from "../../src/core/transcript/itemStore";
import { MemorySessionItemStore } from "../../src/core/transcript/memoryItemStore";
import { MemoryConversationStore } from "../../src/core/transcript/memoryStore";
import { SqliteConversationStore } from "../../src/core/transcript/persistence/sqlite/sqliteConversationStore";

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
  items,
  sessionFrames,
  runner,
}: {
  store: MemoryConversationStore;
  items: SessionItemStore;
  sessionFrames?: SessionFrameBus;
  runner: StepRunner;
}): ConversationApplication {
  return new ConversationApplication({
    agentRuntime: fakeRuntime(),
    store,
    catalog: createBotCatalog([makeBot()]),
    sessionItems: items,
    ...(sessionFrames === undefined ? {} : { sessionFrames }),
    stepRunner: runner,
    onSnapshot: () => undefined,
  });
}

describe("ConversationApplication session integration", () => {
  it("broadcasts live deltas and settled items as frames with one monotonic seq", async () => {
    const store = new MemoryConversationStore();
    const items = new MemorySessionItemStore();
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
    const app = makeApp({ store, items, sessionFrames, runner });

    const result = await app.send(
      undefined,
      "ui-conversation",
      { text: "你好", images: [] },
      "token",
    );
    await app.waitForTurn("ui-conversation", result.turnId);

    // durable 帧的 seq 由条目写入单调分配；用户条目不广播，因此首帧可能从 2 开始。
    const baseSeq = frames[0]?.seq ?? 0;
    expect(frames.map((frame, index) => frame.seq - index)).toEqual(frames.map(() => baseSeq));
    // 增量只走 live 通道，不进入 durable 序列。
    expect(live.filter((frame) => frame.event.type === "text-delta")).toHaveLength(2);
    const textItems = frames.filter(
      (frame) => frame.event.type === "session-item" && frame.event.item.payload.kind === "text",
    );
    expect(textItems).toHaveLength(1);
    expect(frames.every((frame) => frame.sessionId === "ui-conversation")).toBe(true);

    const messageId = result.snapshot.activeMessageId;
    expect(messageId).toBeDefined();
    expect(live.every((frame) => frame.messageId === messageId)).toBe(true);
    const terminal = frames.find(
      (frame) =>
        frame.event.type === "session-item" &&
        frame.event.item.payload.kind === "turn-end" &&
        frame.turnId === result.turnId &&
        frame.event.item.status === "complete",
    );
    expect(terminal).toBeDefined();

    const replayed = await app.readFramesAfter("ui-conversation", 0);
    const replayedSeqs = replayed.map((frame) => frame.seq);
    expect(replayedSeqs).toEqual(replayedSeqs.map((_, index) => index + 1));
    expect(frames.every((frame) => replayedSeqs.includes(frame.seq))).toBe(true);
  });

  it("closes the interrupted assistant message on startup recovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "answra-conversation-recovery-"));
    const conversationId = "recovered-conversation";
    const id = sessionId(conversationId);
    try {
      const previous = new SqliteConversationStore(root);
      await previous.create(conversationId, undefined, { scope: "conversation" });
      await previous.items.appendItems(id, [
        {
          itemId: "user-1",
          status: "complete",
          createdAt: "2026-11-23T10:00:00.000Z",
          turnId: "turn-1",
          payload: { kind: "user", text: "你好", images: [] },
        },
      ]);
      await previous.items.beginTurn(id, "turn-1");
      await previous.items.appendItems(id, [
        {
          itemId: "assistant-1:text",
          status: "interrupted",
          createdAt: "2026-11-23T10:00:01.000Z",
          turnId: "turn-1",
          messageId: "assistant-1",
          authorAgentId: general,
          payload: { kind: "text", text: "半截回复" },
        },
      ]);
      await previous.close();

      const store = new SqliteConversationStore(root);
      try {
        const app = makeApp({
          store,
          items: store.items,
          runner: { run: async () => ({ outcome: "aborted" }) },
        });
        const snapshot = await app.getSnapshot(conversationId);

        expect(snapshot.activeMessageId).toBeUndefined();
        expect(snapshot.messages.map((message) => message.status)).toEqual([
          "complete",
          "interrupted",
        ]);
        const next = await app.send(
          undefined,
          conversationId,
          { text: "继续", images: [] },
          "token",
        );
        await app.waitForTurn(conversationId, next.turnId);
      } finally {
        await store.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

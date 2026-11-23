/** Interview 接入 Session 底座后的断点恢复与 UI 隔离集成测试。 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionFrame } from "@answra/shared/schema";
import { describe, expect, it } from "vitest";
import type { AgentExecutor, AgentModelRequest } from "../../src/core/agent/definition";
import type { AgentRuntime } from "../../src/core/agent/runtime";
import type { StepRunner } from "../../src/core/session/contracts";
import { sessionId } from "../../src/core/session/contracts";
import { SessionFrameBus } from "../../src/core/session/sessionFrameBus";
import type { SessionItemStore } from "../../src/core/transcript/itemStore";
import { MemorySessionItemStore } from "../../src/core/transcript/memoryItemStore";
import { MemoryConversationStore } from "../../src/core/transcript/memoryStore";
import { SqliteConversationStore } from "../../src/core/transcript/persistence/sqlite/sqliteConversationStore";
import { INTERVIEW_REHEARSAL_AGENT_ID } from "../../src/interview/agent";
import { InterviewApplication } from "../../src/interview/application";
import type { InterviewAgentInput } from "../../src/interview/contracts";

const conversationId = "recovered-interview";

function fakeRuntime(): AgentRuntime {
  return {
    chatContextWindow: () => undefined,
    chatEndpoint: () => ({ baseUrl: "http://127.0.0.1:1/v1", model: "test" }),
    generateText: async () => "summary",
    modelTokenProvider: () => async () => "token",
  } as unknown as AgentRuntime;
}

function makeExecutor(): AgentExecutor<InterviewAgentInput> {
  return {
    prepare: async (): Promise<AgentModelRequest> => {
      throw new Error("测试 StepRunner 不准备模型请求");
    },
  };
}

function makeApp({
  store,
  items,
  sessionFrames,
  runner,
  onSnapshot = () => undefined,
}: {
  store: MemoryConversationStore;
  items: SessionItemStore;
  sessionFrames?: SessionFrameBus;
  runner: StepRunner;
  onSnapshot?: (snapshot: Awaited<ReturnType<InterviewApplication["getSnapshot"]>>) => void;
}): InterviewApplication {
  return new InterviewApplication({
    agentRuntime: fakeRuntime(),
    store,
    executor: makeExecutor(),
    authorAgentId: INTERVIEW_REHEARSAL_AGENT_ID,
    requestAccessToken: async () => "token",
    sessionItems: items,
    ...(sessionFrames === undefined ? {} : { sessionFrames }),
    stepRunner: runner,
    onSnapshot: async (snapshot) => onSnapshot(snapshot),
    onTurnCommitted: () => undefined,
    onError: () => undefined,
  });
}

describe("InterviewApplication session recovery", () => {
  it("closes the interrupted turn through new durable frames during recovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "answra-interview-recovery-"));
    const sessionFrames = new SessionFrameBus();
    const frames: SessionFrame[] = [];
    sessionFrames.subscribe({ onFrame: (frame) => frames.push(frame) });
    const id = sessionId(conversationId);
    try {
      const previous = new SqliteConversationStore(root);
      await previous.create(conversationId, undefined, { scope: "interview" });
      await previous.items.appendItems(id, [
        {
          itemId: "user-1",
          status: "complete",
          createdAt: "2026-11-23T10:00:00.000Z",
          turnId: "turn-1",
          payload: { kind: "user", text: "请自我介绍", images: [] },
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
          authorAgentId: INTERVIEW_REHEARSAL_AGENT_ID,
          payload: { kind: "text", text: "半截回答" },
        },
      ]);
      await previous.close();

      const store = new SqliteConversationStore(root);
      try {
        const app = makeApp({
          store,
          items: store.items,
          sessionFrames,
          runner: { run: async () => ({ outcome: "aborted" }) },
        });
        const snapshot = await app.getSnapshot(conversationId);

        expect(snapshot.activeMessageId).toBeUndefined();
        expect(snapshot.messages.map((message) => message.status)).toEqual([
          "complete",
          "interrupted",
        ]);
        // 恢复写回的收口事实是新的 durable 条目帧，客户端按 seq 折叠即可，不需要 UI 挂起。
        const closures = frames.filter(
          (frame) =>
            frame.event.type === "session-item" && frame.event.item.payload.kind === "turn-end",
        );
        expect(closures).toHaveLength(1);
        expect(closures[0]).toMatchObject({
          sessionId: conversationId,
          turnId: "turn-1",
          event: {
            type: "session-item",
            item: { status: "interrupted", payload: { kind: "turn-end", reason: "interrupted" } },
          },
        });
      } finally {
        await store.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a new reply after recovery", async () => {
    const store = new MemoryConversationStore();
    const items = new MemorySessionItemStore();
    const snapshots: Array<{ messages: Array<{ role: string; status: string }> }> = [];
    const app = makeApp({
      store,
      items,
      runner: { run: async () => ({ outcome: "completed", finishReason: "stop" }) },
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });
    await app.createConversation(conversationId);

    const result = await app.sendText(conversationId, "继续");
    await app.waitForTurn(conversationId, result.turnId);

    expect((await app.getSnapshot(conversationId)).messages).toEqual([
      expect.objectContaining({ role: "user", text: "继续", status: "complete" }),
      expect.objectContaining({ role: "assistant", status: "complete" }),
    ]);
    expect(snapshots.length).toBeGreaterThan(0);
  });
});

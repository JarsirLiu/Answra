/** Interview 接入 Session 底座后的断点恢复与 UI 隔离集成测试。 */
import type { AgentEventEnvelope } from "@answra/shared/schema";
import { describe, expect, it, vi } from "vitest";
import type { AgentExecutor, AgentModelRequest } from "../../src/core/agent/definition";
import type { AgentRuntime } from "../../src/core/agent/runtime";
import type { StepRunner } from "../../src/core/session/contracts";
import { sessionId, stepId, turnId } from "../../src/core/session/contracts";
import { MemorySessionJournal } from "../../src/core/session/memoryJournal";
import { MemoryConversationStore } from "../../src/core/transcript/memoryStore";
import { createUserMessage } from "../../src/core/transcript/message";
import { MemoryExecutionStore } from "../../src/execution/memoryStore";
import { INTERVIEW_REHEARSAL_AGENT_ID } from "../../src/interview/agent";
import { InterviewApplication } from "../../src/interview/application";
import type { InterviewAgentInput } from "../../src/interview/contracts";

const conversationId = "recovered-interview";

function fakeRuntime(events: MemoryExecutionStore): AgentRuntime {
  return {
    cancel: vi.fn(),
    waitForRun: vi.fn(async () => undefined),
    getRun: vi.fn(async () => undefined),
    readEventsForRun: vi.fn(async () => []),
    readEvents: vi.fn(async () => []),
    chatContextWindow: () => undefined,
    chatEndpoint: () => ({ baseUrl: "http://127.0.0.1:1/v1", model: "test" }),
    eventStore: () => events,
    generateText: async () => "summary",
    modelTokenProvider: () => async () => "token",
  } as unknown as AgentRuntime;
}

function makeExecutor(): AgentExecutor<InterviewAgentInput> {
  return {
    startRun: async () => {
      throw new Error("Interview 不应再使用 AgentRuntime.startRun");
    },
    prepare: async (): Promise<AgentModelRequest> => {
      throw new Error("测试 StepRunner 不准备模型请求");
    },
  };
}

function makeApp({
  store,
  journal,
  events,
  runner,
  onSnapshot = () => undefined,
}: {
  store: MemoryConversationStore;
  journal: MemorySessionJournal;
  events: MemoryExecutionStore;
  runner: StepRunner;
  onSnapshot?: (snapshot: Awaited<ReturnType<InterviewApplication["getSnapshot"]>>) => void;
}): InterviewApplication {
  return new InterviewApplication({
    agentRuntime: fakeRuntime(events),
    store,
    executor: makeExecutor(),
    authorAgentId: INTERVIEW_REHEARSAL_AGENT_ID,
    requestAccessToken: async () => "token",
    sessionJournal: journal,
    executionStore: events,
    stepRunner: runner,
    onSnapshot: async (snapshot) => onSnapshot(snapshot),
    onTurnCommitted: () => undefined,
    onError: () => undefined,
  });
}

describe("InterviewApplication session recovery", () => {
  it("closes the interrupted assistant message without replaying old terminal events to UI", async () => {
    const store = new MemoryConversationStore();
    const journal = new MemorySessionJournal();
    const events = new MemoryExecutionStore();
    const emitted: AgentEventEnvelope[] = [];
    events.subscribe((event) => emitted.push(event));
    await store.create(conversationId, undefined, { scope: "interview" });
    const user = createUserMessage("user-1", { text: "请自我介绍", images: [] });
    await store.beginSessionTurn(conversationId, {
      turnId: "turn-1",
      messageId: "assistant-1",
      authorAgentId: INTERVIEW_REHEARSAL_AGENT_ID,
      userMessage: user,
    });
    await journal.append(
      sessionId(conversationId),
      { type: "turn-queued", source: "reply", agentId: INTERVIEW_REHEARSAL_AGENT_ID, input: user },
      { turnId: turnId("turn-1") },
    );
    await journal.append(
      sessionId(conversationId),
      { type: "turn-started", agentId: INTERVIEW_REHEARSAL_AGENT_ID },
      { turnId: turnId("turn-1"), messageId: "assistant-1" },
    );
    await journal.append(
      sessionId(conversationId),
      { type: "step-started", stepId: "step-1", index: 0, agentId: INTERVIEW_REHEARSAL_AGENT_ID },
      {
        turnId: turnId("turn-1"),
        stepId: stepId("step-1"),
        messageId: "assistant-1",
      },
    );

    const app = makeApp({
      store,
      journal,
      events,
      runner: { run: async () => ({ outcome: "aborted" }) },
    });
    const snapshot = await app.getSnapshot(conversationId);

    expect(snapshot.activeMessageId).toBeUndefined();
    expect(snapshot.messages.map((message) => message.status)).toEqual(["complete", "interrupted"]);
    // 恢复写入的旧进程终态必须被 UI 挂起，不能污染新进程的事件流。
    expect(emitted.filter((event) => event.runId === "assistant-1")).toEqual([]);
  });

  it("accepts a new reply after recovery", async () => {
    const store = new MemoryConversationStore();
    const journal = new MemorySessionJournal();
    const events = new MemoryExecutionStore();
    const snapshots: Array<{ messages: Array<{ role: string; status: string }> }> = [];
    const app = makeApp({
      store,
      journal,
      events,
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

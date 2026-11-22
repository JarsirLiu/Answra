import { describe, expect, it } from "vitest";
import { type SessionRecoveryPlan, stepId } from "../../../src/core/session/contracts";
import { MemorySessionJournal } from "../../../src/core/session/memoryJournal";
import { planSessionRecovery } from "../../../src/core/session/recovery";
import {
  SessionTranscriptBridge,
  TranscriptSessionJournal,
} from "../../../src/core/session/transcriptBridge";
import { MemoryConversationStore } from "../../../src/core/transcript/memoryStore";
import { TEST_SESSION_ID, TEST_STEP_ID, TEST_TURN_ID, userMessage } from "./fixtures";

async function setup() {
  const store = new MemoryConversationStore();
  await store.create(
    TEST_SESSION_ID,
    {
      activeAgentId: "general",
      participantAgentIds: ["general", "intake"],
      bots: [
        { id: "general", name: "General", role: "assistant" },
        { id: "intake", name: "Intake", role: "assistant" },
      ],
    },
    { scope: "conversation" },
  );
  const bridge = new SessionTranscriptBridge({ store });
  const base = new MemorySessionJournal();
  const journal = new TranscriptSessionJournal(base, bridge);
  return { store, bridge, base, journal };
}

async function startTurn(
  journal: TranscriptSessionJournal,
  options: { messageId?: string; input?: boolean } = {},
) {
  const messageId = options.messageId ?? "assistant-1";
  await journal.append(
    TEST_SESSION_ID,
    {
      type: "turn-queued",
      source: "user",
      agentId: "general",
      ...(options.input === false ? {} : { input: userMessage("user-1", "问题") }),
    },
    { turnId: TEST_TURN_ID },
  );
  await journal.append(
    TEST_SESSION_ID,
    { type: "turn-started", agentId: "general" },
    { turnId: TEST_TURN_ID, messageId },
  );
  return messageId;
}

async function startStep(
  journal: TranscriptSessionJournal,
  messageId: string,
  options: { stepId?: string; agentId?: string; index?: number } = {},
) {
  await journal.append(
    TEST_SESSION_ID,
    {
      type: "step-started",
      stepId: options.stepId ?? TEST_STEP_ID,
      index: options.index ?? 0,
      agentId: options.agentId ?? "general",
    },
    {
      turnId: TEST_TURN_ID,
      stepId: stepId(options.stepId ?? TEST_STEP_ID),
      messageId,
    },
  );
}

async function writeText(
  journal: TranscriptSessionJournal,
  bridge: SessionTranscriptBridge,
  messageId: string,
  partId = "text-1",
  delta = "回答",
) {
  await journal.append(
    TEST_SESSION_ID,
    { type: "text-start", partId },
    { turnId: TEST_TURN_ID, stepId: TEST_STEP_ID, messageId },
  );
  await bridge.applyLive(TEST_SESSION_ID, messageId, {
    type: "text-delta",
    partId,
    delta,
  });
  await journal.append(
    TEST_SESSION_ID,
    { type: "text-end", partId },
    { turnId: TEST_TURN_ID, stepId: TEST_STEP_ID, messageId },
  );
}

describe("SessionTranscriptBridge", () => {
  it("projects a completed turn into user and assistant messages", async () => {
    const { store, bridge, journal } = await setup();
    const messageId = await startTurn(journal);
    await startStep(journal, messageId);
    await writeText(journal, bridge, messageId, "text-1", "你好");
    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-finished", status: "completed", reason: "completed" },
      { turnId: TEST_TURN_ID },
    );

    const snapshot = await store.load(TEST_SESSION_ID);
    expect(snapshot.messages).toMatchObject([
      { id: "user-1", role: "user", text: "问题", status: "complete" },
      {
        id: "assistant-1",
        role: "assistant",
        text: "你好",
        status: "complete",
        parts: [{ id: "text-1", kind: "text", text: "你好", state: "completed" }],
      },
    ]);
    expect(snapshot.activeRunId).toBeUndefined();
    expect(await journal.readAfter(TEST_SESSION_ID, 0)).toHaveLength(6);
  });

  it("keeps each handoff Bot's assistant message and transfers the active agent", async () => {
    const { store, bridge, journal } = await setup();
    await startTurn(journal, { messageId: "assistant-1" });
    await startStep(journal, "assistant-1");
    await writeText(journal, bridge, "assistant-1", "text-1", "先回答");
    await journal.append(
      TEST_SESSION_ID,
      {
        type: "turn-handoff",
        fromAgentId: "general",
        toAgentId: "intake",
        task: "整理资料",
      },
      { turnId: TEST_TURN_ID, messageId: "assistant-1" },
    );
    await startStep(journal, "assistant-2", {
      stepId: "step-2",
      agentId: "intake",
      index: 1,
    });
    await writeText(journal, bridge, "assistant-2", "text-2", "已整理");
    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-finished", status: "completed", reason: "completed" },
      { turnId: TEST_TURN_ID },
    );

    const snapshot = await store.load(TEST_SESSION_ID);
    expect(snapshot.messages).toMatchObject([
      { id: "user-1", role: "user" },
      { id: "assistant-1", authorAgentId: "general", status: "complete", text: "先回答" },
      {
        role: "assistant",
        authorAgentId: "general",
        audience: { kind: "bot", agentId: "intake" },
        text: "整理资料",
        status: "complete",
      },
      { id: "assistant-2", authorAgentId: "intake", status: "complete", text: "已整理" },
    ]);
    expect(snapshot.activeAgentId).toBe("intake");
    expect(snapshot.activeRunId).toBeUndefined();
  });

  it("settles an aborted turn as interrupted", async () => {
    const { store, bridge, journal } = await setup();
    const messageId = await startTurn(journal);
    await startStep(journal, messageId);
    await writeText(journal, bridge, messageId, "text-1", "半句");
    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-finished", status: "aborted", reason: "cancelled" },
      { turnId: TEST_TURN_ID },
    );

    const snapshot = await store.load(TEST_SESSION_ID);
    expect(snapshot.messages[1]).toMatchObject({
      id: "assistant-1",
      status: "interrupted",
      text: "半句",
    });
  });

  it("settles the last assistant message of an interrupted turn after recovery", async () => {
    const { store, bridge, journal } = await setup();
    const messageId = await startTurn(journal);
    await startStep(journal, messageId);
    await writeText(journal, bridge, messageId, "text-1", "半句");
    const plan: SessionRecoveryPlan = {
      projection: {
        sessionId: TEST_SESSION_ID,
        sequence: 4,
        turns: [
          {
            sessionId: TEST_SESSION_ID,
            turnId: TEST_TURN_ID,
            source: "user",
            status: "running",
            agentId: "general",
            activeAgentId: "general",
            assistantMessageIds: [messageId],
            handoffCount: 0,
            createdAt: "2026-11-21T00:00:00.000Z",
            startedAt: "2026-11-21T00:00:01.000Z",
          },
        ],
        queue: [],
        steps: [],
        compactions: [],
      },
      interruptedTurnIds: [TEST_TURN_ID],
      interruptedStepIds: [],
      interruptedCompactionIds: [],
    };

    await bridge.recover(TEST_SESSION_ID, plan);

    const snapshot = await store.load(TEST_SESSION_ID);
    expect(snapshot.messages[1]).toMatchObject({
      id: "assistant-1",
      status: "interrupted",
      text: "半句",
    });
    expect(snapshot.activeRunId).toBeUndefined();
  });

  it("restores a queued turn's input after a worker restart", async () => {
    const { store, base } = await setup();
    const firstJournal = new TranscriptSessionJournal(base, new SessionTranscriptBridge({ store }));
    await firstJournal.append(
      TEST_SESSION_ID,
      {
        type: "turn-queued",
        source: "user",
        agentId: "general",
        input: userMessage("user-1", "排队问题"),
      },
      { turnId: TEST_TURN_ID },
    );

    // 模拟 worker 重启：新 bridge 没有旧进程的 turn-queued 内存状态。
    const restarted = new SessionTranscriptBridge({ store });
    const plan = planSessionRecovery(TEST_SESSION_ID, await base.readAfter(TEST_SESSION_ID, 0));
    await restarted.recover(TEST_SESSION_ID, plan);

    const restartedJournal = new TranscriptSessionJournal(base, restarted);
    await restartedJournal.append(
      TEST_SESSION_ID,
      { type: "turn-started", agentId: "general" },
      { turnId: TEST_TURN_ID, messageId: "assistant-1" },
    );

    const snapshot = await store.load(TEST_SESSION_ID);
    expect(snapshot.messages).toMatchObject([
      { id: "user-1", role: "user", text: "排队问题" },
      { id: "assistant-1", role: "assistant" },
    ]);
  });

  it("rejects a step whose assistant message has no placeholder", async () => {
    const { journal } = await setup();
    await expect(
      journal.append(
        TEST_SESSION_ID,
        {
          type: "step-started",
          stepId: TEST_STEP_ID,
          index: 0,
          agentId: "general",
        },
        { turnId: TEST_TURN_ID, stepId: TEST_STEP_ID, messageId: "assistant-1" },
      ),
    ).rejects.toThrow("缺少 assistant 占位");
  });
});

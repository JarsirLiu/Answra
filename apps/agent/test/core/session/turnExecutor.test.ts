import { describe, expect, it } from "vitest";
import type {
  StepRunContext,
  StepRunner,
  StepRunnerResult,
  StepStart,
  TurnStart,
} from "../../../src/core/session/contracts";
import { stepId } from "../../../src/core/session/contracts";
import { MemorySessionJournal } from "../../../src/core/session/memoryJournal";
import { projectSession } from "../../../src/core/session/projection";
import { SessionStepExecutor } from "../../../src/core/session/stepExecutor";
import { SessionTurnExecutor } from "../../../src/core/session/turnExecutor";
import { TEST_SESSION_ID, TEST_TURN_ID, TEST_TURN_RUNTIME, userMessage } from "./fixtures";

class ScriptedStepRunner implements StepRunner {
  readonly calls: StepStart[] = [];
  private readonly results: StepRunnerResult[];

  constructor(...results: StepRunnerResult[]) {
    this.results = results;
  }

  async run(
    step: StepStart,
    _context: StepRunContext,
    _signal: AbortSignal,
  ): Promise<StepRunnerResult> {
    this.calls.push(step);
    const result = this.results.shift();
    if (result === undefined) throw new Error("测试没有配置下一个 step 结果");
    return result;
  }
}

function turnStart(): TurnStart {
  return {
    sessionId: TEST_SESSION_ID,
    turnId: TEST_TURN_ID,
    source: "user",
    agentId: "general",
    input: userMessage(),
  };
}

async function startedJournal(): Promise<MemorySessionJournal> {
  const journal = new MemorySessionJournal();
  await journal.append(
    TEST_SESSION_ID,
    { type: "turn-queued", source: "user", input: userMessage(), agentId: "general" },
    { turnId: TEST_TURN_ID },
  );
  await journal.append(
    TEST_SESSION_ID,
    { type: "turn-started", agentId: "general" },
    { turnId: TEST_TURN_ID },
  );
  return journal;
}

function createExecutor(
  journal: MemorySessionJournal,
  runner: StepRunner,
  maxSteps?: number,
): SessionTurnExecutor {
  const ids = ["step-1", "step-2", "step-3", "step-4"];
  const messageIds = ["assistant-1", "assistant-2", "assistant-3", "assistant-4"];
  return new SessionTurnExecutor({
    journal,
    stepExecutor: new SessionStepExecutor({ journal, runner }),
    createStepId: () => stepId(ids.shift() ?? `step-${ids.length}`),
    createMessageId: () => messageIds.shift() ?? "assistant-fallback",
    ...(maxSteps === undefined ? {} : { maxSteps }),
  });
}

describe("SessionTurnExecutor", () => {
  it("continues after tool-call steps and completes in the same turn", async () => {
    const journal = await startedJournal();
    const runner = new ScriptedStepRunner(
      { outcome: "completed", finishReason: "tool-calls" },
      { outcome: "completed", finishReason: "stop" },
    );
    const executor = createExecutor(journal, runner);

    await expect(
      executor.run(turnStart(), TEST_TURN_RUNTIME, new AbortController().signal),
    ).resolves.toEqual({
      turnId: TEST_TURN_ID,
      outcome: "completed",
      reason: "completed",
    });

    expect(runner.calls.map((step) => step.index)).toEqual([0, 1]);
    expect(runner.calls.map((step) => step.agentId)).toEqual(["general", "general"]);
    expect(runner.calls.map((step) => step.messageId)).toEqual(["assistant-1", "assistant-1"]);
    expect(runner.calls.map((step) => step.handoff)).toEqual([undefined, undefined]);
    const events = await journal.readAfter(TEST_SESSION_ID, 0);
    expect(events.some((event) => event.event.type === "turn-finished")).toBe(false);
    const projection = projectSession(TEST_SESSION_ID, events);
    expect(projection.turns[0]).toMatchObject({ status: "running", handoffCount: 0 });
    expect(projection.steps.map((step) => step.status)).toEqual(["completed", "completed"]);
  });

  it("writes a handoff and keeps the next Bot in the same turn", async () => {
    const journal = await startedJournal();
    const runner = new ScriptedStepRunner(
      {
        outcome: "completed",
        finishReason: "stop",
        handoff: { toAgentId: " intake ", task: "整理简历资料" },
      },
      { outcome: "completed", finishReason: "stop" },
    );
    const executor = createExecutor(journal, runner);

    await expect(
      executor.run(turnStart(), TEST_TURN_RUNTIME, new AbortController().signal),
    ).resolves.toEqual({
      turnId: TEST_TURN_ID,
      outcome: "completed",
      reason: "completed",
    });

    expect(runner.calls.map((step) => step.agentId)).toEqual(["general", "intake"]);
    expect(runner.calls.map((step) => step.messageId)).toEqual(["assistant-1", "assistant-2"]);
    expect(runner.calls.map((step) => step.handoff)).toEqual([
      undefined,
      {
        fromAgentId: "general",
        task: "整理简历资料",
        sourceMessageId: "assistant-1",
      },
    ]);
    const events = await journal.readAfter(TEST_SESSION_ID, 0);
    const handoff = events.find((event) => event.event.type === "turn-handoff");
    expect(handoff).toMatchObject({
      messageId: "assistant-1",
      event: {
        fromAgentId: "general",
        toAgentId: "intake",
        task: "整理简历资料",
      },
    });
    const projection = projectSession(TEST_SESSION_ID, events);
    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0]).toMatchObject({
      status: "running",
      activeAgentId: "intake",
      handoffCount: 1,
      assistantMessageIds: ["assistant-1", "assistant-2"],
    });
  });

  it("keeps the handoff input for every step of the target Bot", async () => {
    const journal = await startedJournal();
    const runner = new ScriptedStepRunner(
      {
        outcome: "completed",
        finishReason: "stop",
        handoff: { toAgentId: "intake", task: "整理简历资料" },
      },
      { outcome: "completed", finishReason: "tool-calls" },
      { outcome: "completed", finishReason: "stop" },
    );
    const executor = createExecutor(journal, runner);

    await executor.run(turnStart(), TEST_TURN_RUNTIME, new AbortController().signal);

    const handoff = {
      fromAgentId: "general",
      task: "整理简历资料",
      sourceMessageId: "assistant-1",
    };
    expect(runner.calls.map((step) => step.agentId)).toEqual(["general", "intake", "intake"]);
    expect(runner.calls.map((step) => step.messageId)).toEqual([
      "assistant-1",
      "assistant-2",
      "assistant-2",
    ]);
    expect(runner.calls.map((step) => step.handoff)).toEqual([undefined, handoff, handoff]);
    expect(runner.calls.map((step) => step.input)).toEqual([
      userMessage(),
      userMessage(),
      userMessage(),
    ]);
  });

  it("fails the turn when a handoff target or task is invalid", async () => {
    const journal = await startedJournal();
    const runner = new ScriptedStepRunner({
      outcome: "completed",
      finishReason: "stop",
      handoff: { toAgentId: "intake", task: "  " },
    });
    const executor = createExecutor(journal, runner);

    const finish = await executor.run(turnStart(), TEST_TURN_RUNTIME, new AbortController().signal);

    expect(finish).toMatchObject({ outcome: "failed", reason: "handoff-failed" });
    expect(finish.errorText).toContain("交接内容");
    const events = await journal.readAfter(TEST_SESSION_ID, 0);
    expect(events.some((event) => event.event.type === "turn-handoff")).toBe(false);
  });

  it("keeps a step failure observable without writing the turn terminal event", async () => {
    const journal = await startedJournal();
    const runner: StepRunner = {
      async run(): Promise<StepRunnerResult> {
        throw new Error("provider failed");
      },
    };
    const executor = createExecutor(journal, runner);

    await expect(
      executor.run(turnStart(), TEST_TURN_RUNTIME, new AbortController().signal),
    ).resolves.toMatchObject({
      turnId: TEST_TURN_ID,
      outcome: "failed",
      reason: "unknown",
      errorText: "provider failed",
    });

    const events = await journal.readAfter(TEST_SESSION_ID, 0);
    expect(events.some((event) => event.event.type === "turn-finished")).toBe(false);
    expect(events[3]).toMatchObject({
      event: { type: "step-finished", state: "failed", errorText: "provider failed" },
    });
  });

  it("stops a runaway step loop with an observable failure", async () => {
    const journal = await startedJournal();
    const runner = new ScriptedStepRunner(
      { outcome: "completed", finishReason: "tool-calls" },
      { outcome: "completed", finishReason: "tool-calls" },
    );
    const executor = createExecutor(journal, runner, 2);

    const finish = await executor.run(turnStart(), TEST_TURN_RUNTIME, new AbortController().signal);

    expect(finish).toMatchObject({ outcome: "failed", reason: "unknown" });
    expect(finish.errorText).toContain("最大 step 数");
    expect(runner.calls).toHaveLength(2);
  });

  it("does not call the step executor after cancellation", async () => {
    const journal = await startedJournal();
    const runner = new ScriptedStepRunner({ outcome: "completed", finishReason: "stop" });
    const executor = createExecutor(journal, runner);
    const controller = new AbortController();
    controller.abort();

    await expect(executor.run(turnStart(), TEST_TURN_RUNTIME, controller.signal)).resolves.toEqual({
      turnId: TEST_TURN_ID,
      outcome: "aborted",
      reason: "cancelled",
    });
    expect(runner.calls).toEqual([]);
  });
});

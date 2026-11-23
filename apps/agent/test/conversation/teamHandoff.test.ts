import type { ConversationSnapshot } from "@answra/shared";
import { describe, expect, it, vi } from "vitest";
import { ConversationApplication } from "../../src/conversation/application";
import type { ConversationBot } from "../../src/conversation/bots/types";
import { CHAT_PROFILES } from "../../src/conversation/profiles/registry";
import { agentId } from "../../src/core/agent/definition";
import type { AgentRuntime } from "../../src/core/agent/runtime";
import { createBotCatalog } from "../../src/core/bot/catalog";
import type { StepRunner, StepRunnerResult, TurnHandoff } from "../../src/core/session/contracts";
import { sessionId } from "../../src/core/session/contracts";
import { MemorySessionJournal } from "../../src/core/session/memoryJournal";
import type { TeamPreset } from "../../src/core/team/preset";
import { MemoryConversationStore } from "../../src/core/transcript/memoryStore";

const candidate = agentId("candidate");
const intake = agentId("intake");

type InputRecord = { agentId: string; text: string };

function scriptedRunner({
  inputs,
  resultFor,
  textFor,
  gate,
}: {
  inputs: InputRecord[];
  resultFor: (stepAgentId: string) => TurnHandoff | undefined;
  textFor: (stepAgentId: string, index: number) => string;
  gate?: Promise<void>;
}): StepRunner {
  return {
    async run(step, context, signal) {
      if (gate) await gate;
      if (signal.aborted) return { outcome: "aborted" };
      inputs.push({
        agentId: step.agentId,
        text: step.handoff?.task ?? step.input?.text ?? "",
      });
      await context.events.append({ type: "text-start", partId: "text" });
      await context.events.append({
        type: "text-delta",
        partId: "text",
        delta: textFor(step.agentId, step.index),
      });
      await context.events.append({ type: "text-end", partId: "text" });
      const handoff = resultFor(step.agentId);
      const result: StepRunnerResult = {
        outcome: "completed",
        finishReason: "stop",
        ...(handoff === undefined ? {} : { handoff }),
      };
      return result;
    },
  };
}

function createHarness({
  candidateHandoff,
  gate,
  journal = new MemorySessionJournal(),
}: {
  candidateHandoff?: TurnHandoff;
  gate?: Promise<void>;
  journal?: MemorySessionJournal;
}) {
  const store = new MemoryConversationStore();
  const conversationId = "handoff-conversation";
  const inputs: InputRecord[] = [];
  const snapshots: ConversationSnapshot[] = [];
  const runner = scriptedRunner({
    inputs,
    gate,
    resultFor: (agent) => (agent === candidate ? candidateHandoff : undefined),
    textFor: (agent) => (agent === candidate ? "我先整理一下。" : "我来接管。"),
  });
  const makeBot = (id: typeof candidate): ConversationBot => ({
    id,
    identity: {
      name: id === candidate ? "候选人" : "面试向导",
      role: id === candidate ? "candidate" : "intake",
      responsibility: "处理当前任务。",
      owns: [id],
    },
    discovery: { visibleTo: { kind: "team", teamId: "interview" } },
    domain: "conversation",
    executor: {
      prepare: async () => {
        throw new Error("注入的 StepRunner 不需要 prepare");
      },
    },
    policy: CHAT_PROFILES["general-chat"],
  });
  const preset: TeamPreset = {
    teamId: "interview",
    entryBotId: candidate,
    memberBotIds: [candidate, intake],
  };
  const agentRuntime = {
    assertRegistered: vi.fn(),
    assertTeamMembers: vi.fn(),
    dispose: vi.fn(),
    chatContextWindow: () => undefined,
  } as unknown as AgentRuntime;

  const app = new ConversationApplication({
    agentRuntime,
    store,
    catalog: createBotCatalog([makeBot(candidate), makeBot(intake)]),
    presets: [preset],
    sessionJournal: journal,
    stepRunner: runner,
    onSnapshot: (snapshot) => {
      snapshots.push(snapshot);
    },
  });

  return { app, store, conversationId, inputs, snapshots, journal };
}

describe("ConversationApplication team handoff", () => {
  it("runs the source Bot, writes one handoff record, then lets the target Bot reply", async () => {
    const harness = createHarness({
      candidateHandoff: { toAgentId: intake, task: "请接管整理并继续追问。" },
    });

    const result = await harness.app.sendTeamMessage(
      "interview",
      harness.conversationId,
      { text: "帮我准备面试", images: [] },
      "token",
    );

    expect(result.turnId).toBeTruthy();
    expect(result.snapshot.messages).toHaveLength(4);
    expect(
      result.snapshot.messages.map((message) => ({
        role: message.role,
        author: message.authorAgentId,
        audience: message.audience,
        text: message.text,
        status: message.status,
      })),
    ).toEqual([
      {
        role: "user",
        author: undefined,
        audience: { kind: "user" },
        text: "帮我准备面试",
        status: "complete",
      },
      {
        role: "assistant",
        author: candidate,
        audience: { kind: "user" },
        text: "我先整理一下。",
        status: "complete",
      },
      {
        role: "assistant",
        author: candidate,
        audience: { kind: "bot", agentId: intake },
        text: "请接管整理并继续追问。",
        status: "complete",
      },
      {
        role: "assistant",
        author: intake,
        audience: { kind: "user" },
        text: "我来接管。",
        status: "complete",
      },
    ]);
    expect(result.snapshot.activeAgentId).toBe(intake);
    expect(result.snapshot.activeMessageId).toBeUndefined();
    expect(harness.inputs.map((recorded) => recorded.agentId)).toEqual([candidate, intake]);
    expect(harness.inputs[1]?.text).toBe("请接管整理并继续追问。");
    expect(harness.snapshots.length).toBeGreaterThanOrEqual(3);
  });

  it("records durable step boundaries in the session journal", async () => {
    const journal = new MemorySessionJournal();
    const harness = createHarness({ candidateHandoff: undefined, journal });

    await harness.app.sendTeamMessage(
      "interview",
      harness.conversationId,
      { text: "帮我准备面试", images: [] },
      "token",
    );

    const events = await journal.readAfter(sessionId("handoff-conversation"), 0);
    expect(events.map((event) => event.event.type)).toEqual([
      "turn-queued",
      "turn-started",
      "step-started",
      "text-start",
      "text-end",
      "step-finished",
      "turn-finished",
    ]);
    expect(events.every((event) => event.sequence > 0)).toBe(true);
  });

  it("rejects an invisible handoff target without writing a handoff record", async () => {
    const harness = createHarness({
      candidateHandoff: { toAgentId: agentId("outsider"), task: "越权接管" },
    });

    await expect(
      harness.app.sendTeamMessage(
        "interview",
        harness.conversationId,
        { text: "帮我准备面试", images: [] },
        "token",
      ),
    ).rejects.toThrow("Bot 无法发现交接目标：candidate -> outsider");

    const snapshot = await harness.app.getSnapshot(harness.conversationId);
    expect(snapshot.messages.map((message) => message.audience?.kind)).toEqual(["user", "user"]);
    expect(snapshot.activeAgentId).toBe(candidate);
    expect(snapshot.activeMessageId).toBeUndefined();
  });

  it("finishes the handoff chain before starting a queued user turn", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = createHarness({
      gate,
      candidateHandoff: { toAgentId: intake, task: "handoff after first" },
    });

    const first = harness.app.enqueueTeamMessage(
      "interview",
      harness.conversationId,
      { text: "first", images: [] },
      "token",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await harness.app.enqueueTeamMessage(
      "interview",
      harness.conversationId,
      { text: "second", images: [] },
      "token",
    );
    expect(second.status).toBe("queued");

    release();
    const accepted = await first;
    expect(accepted.status).toBe("started");
    await harness.app.waitForQueue(harness.conversationId, accepted.queueId);
    await harness.app.waitForQueue(harness.conversationId, second.queueId);

    expect(harness.inputs.map((recorded) => recorded.agentId)).toEqual([
      candidate,
      intake,
      candidate,
      intake,
    ]);
    const snapshot = await harness.app.getSnapshot(harness.conversationId);
    expect(snapshot.messages.map((message) => message.text)).toEqual([
      "first",
      "我先整理一下。",
      "handoff after first",
      "我来接管。",
      "second",
      "我先整理一下。",
      "handoff after first",
      "我来接管。",
    ]);
    expect(snapshot.activeAgentId).toBe(intake);
  });
});

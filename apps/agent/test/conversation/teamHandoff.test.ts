import type { ConversationSnapshot } from "@answra/shared";
import type { AgentEvent, AgentEventEnvelope } from "@answra/shared/schema";
import { describe, expect, it, vi } from "vitest";
import type { ConversationAgentInput } from "../../src/conversation/agent";
import { ConversationApplication } from "../../src/conversation/application";
import type { ConversationBot } from "../../src/conversation/bots/types";
import { CHAT_PROFILES } from "../../src/conversation/profiles/registry";
import type {
  AgentExecutor,
  AgentId,
  AgentRunHandle,
  AgentRunRequest,
  BotTurnResult,
} from "../../src/core/agent/definition";
import { agentId } from "../../src/core/agent/definition";
import type { AgentRuntime } from "../../src/core/agent/runtime";
import { createBotCatalog } from "../../src/core/bot/catalog";
import type { TeamPreset } from "../../src/core/team/preset";
import { MemoryConversationStore } from "../../src/core/transcript/memoryStore";

const candidate = agentId("candidate");
const intake = agentId("intake");

function eventEnvelope(
  conversationId: string,
  runId: string,
  aggregateRevision: number,
  event: AgentEvent,
): AgentEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `event-${aggregateRevision}`,
    conversationId,
    runId,
    attemptId: `${runId}:attempt:1`,
    sequence: aggregateRevision,
    aggregateRevision,
    producerId: "test",
    occurredAt: "2026-11-11T00:00:00.000Z",
    event,
  };
}

type RecordedInput = { agentId: AgentId; input: ConversationAgentInput };
type ScriptedResult =
  | BotTurnResult
  | undefined
  | ((input: ConversationAgentInput) => BotTurnResult | undefined);

function createScriptedExecutor({
  conversationId,
  text,
  result,
  revision,
  sequence,
  onInput,
  onRequest,
  gate,
}: {
  conversationId: string;
  text: string;
  result: ScriptedResult;
  revision: { value: number };
  sequence: { value: number };
  onInput: (input: ConversationAgentInput) => void;
  onRequest: (request: AgentRunRequest<ConversationAgentInput, unknown>) => void;
  gate?: Promise<void>;
}): AgentExecutor<ConversationAgentInput> {
  return {
    async startRun<Prepared>(
      request: AgentRunRequest<ConversationAgentInput, Prepared>,
    ): Promise<AgentRunHandle<Prepared>> {
      onRequest(request);
      if (gate) await gate;
      const runId = `run-${++sequence.value}`;
      const prepared = await request.prepareRun({
        runId,
        eventRevision: revision.value,
      });
      onInput(prepared.input);
      const resolvedResult = typeof result === "function" ? result(prepared.input) : result;

      let currentRevision = revision.value;
      const stream: AgentEvent[] = [
        { type: "text-start", partId: "text" },
        { type: "text-delta", partId: "text", delta: text },
        { type: "text-end", partId: "text" },
      ];
      for (const event of stream) {
        currentRevision += 1;
        await request.onEvent(eventEnvelope(conversationId, runId, currentRevision, event));
      }
      currentRevision += 1;
      await request.onEvent(
        eventEnvelope(conversationId, runId, currentRevision, {
          type: "run-state-changed",
          state: "completed",
          attempt: 1,
        }),
      );
      revision.value = currentRevision;

      return {
        runId,
        eventRevision: currentRevision,
        prepared: prepared.prepared,
        result: Promise.resolve(resolvedResult),
        done: Promise.resolve("completed" as const),
      };
    },
    prepare: async () => {
      throw new Error("not used");
    },
  };
}

function createHarness({
  candidateResult,
  candidateText = "我先整理一下。",
  intakeText = "我来接管。",
  gate,
}: {
  candidateResult: ScriptedResult;
  candidateText?: string;
  intakeText?: string;
  gate?: Promise<void>;
}) {
  const store = new MemoryConversationStore();
  const conversationId = "handoff-conversation";
  const revision = { value: 0 };
  const sequence = { value: 0 };
  const inputs: RecordedInput[] = [];
  const snapshots: ConversationSnapshot[] = [];
  const requests: Array<AgentRunRequest<ConversationAgentInput, unknown>> = [];

  const candidateExecutor = createScriptedExecutor({
    conversationId,
    text: candidateText,
    result: candidateResult,
    revision,
    sequence,
    onInput: (input) => inputs.push({ agentId: candidate, input }),
    onRequest: (request) => requests.push(request),
    gate,
  });
  const intakeExecutor = createScriptedExecutor({
    conversationId,
    text: intakeText,
    result: undefined,
    revision,
    sequence,
    onInput: (input) => inputs.push({ agentId: intake, input }),
    onRequest: (request) => requests.push(request),
  });

  const candidateBot: ConversationBot = {
    id: candidate,
    identity: {
      name: "候选人",
      role: "candidate",
      responsibility: "准备候选人材料。",
      owns: ["candidate"],
    },
    discovery: { visibleTo: { kind: "team", teamId: "interview" } },
    domain: "conversation",
    executor: candidateExecutor,
    policy: CHAT_PROFILES["general-chat"],
  };
  const intakeBot: ConversationBot = {
    id: intake,
    identity: {
      name: "面试向导",
      role: "intake",
      responsibility: "接管会话并推进面试准备。",
      owns: ["intake"],
    },
    discovery: { visibleTo: { kind: "team", teamId: "interview" } },
    domain: "conversation",
    executor: intakeExecutor,
    policy: CHAT_PROFILES["general-chat"],
  };
  const preset: TeamPreset = {
    teamId: "interview",
    entryBotId: candidate,
    memberBotIds: [candidate, intake],
  };

  const agentRuntime = {
    assertRegistered: vi.fn(),
    assertTeamMembers: vi.fn(),
    dispose: vi.fn(),
    cancel: vi.fn(),
    waitForRun: vi.fn(async () => undefined),
    getRun: vi.fn(async () => undefined),
    readEventsForRun: vi.fn(async () => [] as AgentEventEnvelope[]),
    readEvents: vi.fn(async () => [] as AgentEventEnvelope[]),
    getConversationRevision: vi.fn(async () => revision.value),
    activeRunCount: 0,
  } as unknown as AgentRuntime;

  const app = new ConversationApplication({
    agentRuntime,
    store,
    catalog: createBotCatalog([candidateBot, intakeBot]),
    presets: [preset],
    onSnapshot: (snapshot) => {
      snapshots.push(snapshot);
    },
  });

  return { app, store, conversationId, inputs, snapshots, requests };
}

describe("ConversationApplication team handoff", () => {
  it("runs the source Bot, writes one handoff record, then lets the target Bot reply", async () => {
    const harness = createHarness({
      candidateResult: {
        kind: "handoff",
        to: intake,
        task: "请接管整理并继续追问。",
      },
    });

    const result = await harness.app.sendTeamMessage(
      "interview",
      harness.conversationId,
      { text: "帮我准备面试", images: [] },
      "token",
    );

    expect(result.runId).toBe("run-1");
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
    expect(result.snapshot.activeRunId).toBeUndefined();
    expect(harness.inputs.map((recorded) => recorded.agentId)).toEqual([candidate, intake]);
    expect(harness.inputs[1]?.input.request.text).toBe("请接管整理并继续追问。");
    expect(harness.snapshots.length).toBeGreaterThanOrEqual(3);
  });

  it("wires provider overflow recovery into the existing Bot run", async () => {
    const harness = createHarness({ candidateResult: undefined });

    await harness.app.sendTeamMessage(
      "interview",
      harness.conversationId,
      { text: "帮我准备面试", images: [] },
      "token",
    );

    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.recoverContext).toBeTypeOf("function");
  });

  it("rejects an invisible handoff target without writing a handoff record", async () => {
    const harness = createHarness({
      candidateResult: {
        kind: "handoff",
        to: agentId("outsider"),
        task: "越权接管",
      },
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
    expect(snapshot.activeRunId).toBeUndefined();
  });

  it("skips the handoff chain when a user turn is already queued", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = createHarness({
      candidateResult: (input) =>
        input.request.text === "first"
          ? { kind: "handoff", to: intake, task: "handoff after first" }
          : undefined,
      gate,
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

    expect(harness.inputs.map((recorded) => recorded.agentId)).toEqual([candidate, candidate]);
    const snapshot = await harness.app.getSnapshot(harness.conversationId);
    expect(snapshot.messages.map((message) => message.text)).toEqual([
      "first",
      "我先整理一下。",
      "second",
      "我先整理一下。",
    ]);
    expect(snapshot.messages.some((message) => message.audience?.kind === "bot")).toBe(false);
    expect(snapshot.activeAgentId).toBe(candidate);
  });
});

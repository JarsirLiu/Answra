import type { AgentEvent, AgentEventEnvelope } from "@answra/shared/schema";
import { describe, expect, it, vi } from "vitest";
import type { ConversationAgentInput } from "../../src/conversation/agent";
import { ConversationApplication } from "../../src/conversation/application";
import type { ConversationBot } from "../../src/conversation/bots/types";
import { CHAT_PROFILES } from "../../src/conversation/profiles/registry";
import type {
  AgentExecutor,
  AgentRunHandle,
  AgentRunRequest,
  BotTurnResult,
} from "../../src/core/agent/definition";
import { agentId } from "../../src/core/agent/definition";
import type { AgentRuntime } from "../../src/core/agent/runtime";
import { createBotCatalog } from "../../src/core/bot/catalog";
import type { TeamPreset } from "../../src/core/team/preset";
import { MemoryConversationStore } from "../../src/core/transcript/memoryStore";

const first = agentId("first");
const second = agentId("second");

function eventEnvelope(
  conversationId: string,
  runId: string,
  revision: number,
  event: AgentEvent,
): AgentEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `event-${revision}`,
    conversationId,
    runId,
    attemptId: `${runId}:attempt:1`,
    sequence: revision,
    aggregateRevision: revision,
    producerId: "test",
    occurredAt: "2026-11-12T00:00:00.000Z",
    event,
  };
}

function executor({
  conversationId,
  text,
  result,
  revision,
  sequence,
  onInput,
}: {
  conversationId: string;
  text: string;
  result: BotTurnResult | undefined;
  revision: { value: number };
  sequence: { value: number };
  onInput: (agent: string, input: ConversationAgentInput) => void;
}): AgentExecutor<ConversationAgentInput> {
  return {
    async startRun<Prepared>(
      request: AgentRunRequest<ConversationAgentInput, Prepared>,
    ): Promise<AgentRunHandle<Prepared>> {
      const runId = `run-${++sequence.value}`;
      const prepared = await request.prepareRun({ runId, eventRevision: revision.value });
      onInput(prepared.input.viewerAgentId ?? "", prepared.input);
      let current = revision.value;
      for (const event of [
        { type: "text-start", partId: "text" } as const,
        { type: "text-delta", partId: "text", delta: text } as const,
        { type: "text-end", partId: "text" } as const,
      ]) {
        current += 1;
        await request.onEvent(eventEnvelope(conversationId, runId, current, event));
      }
      current += 1;
      await request.onEvent(
        eventEnvelope(conversationId, runId, current, {
          type: "run-state-changed",
          state: "completed",
          attempt: 1,
        }),
      );
      revision.value = current;
      return {
        runId,
        eventRevision: current,
        prepared: prepared.prepared,
        result: Promise.resolve(result),
        done: Promise.resolve("completed" as const),
      };
    },
  };
}

function createHarness({ result }: { result?: BotTurnResult }) {
  const store = new MemoryConversationStore();
  const conversationId = "selection-conversation";
  const revision = { value: 0 };
  const sequence = { value: 0 };
  const inputs: Array<{ agent: string; input: ConversationAgentInput }> = [];
  const errors: unknown[] = [];

  const firstBot: ConversationBot = {
    id: first,
    identity: { name: "第一个", role: "first", responsibility: "first", owns: ["first"] },
    discovery: { visibleTo: { kind: "team", teamId: "solo" } },
    domain: "conversation",
    executor: executor({
      conversationId,
      text: "第一个回复",
      result,
      revision,
      sequence,
      onInput: (agent, input) => inputs.push({ agent, input }),
    }),
    policy: CHAT_PROFILES["general-chat"],
  };
  const secondBot: ConversationBot = {
    id: second,
    identity: { name: "第二个", role: "second", responsibility: "second", owns: ["second"] },
    discovery: { visibleTo: { kind: "team", teamId: "solo" } },
    domain: "conversation",
    executor: executor({
      conversationId,
      text: "第二个回复",
      result: undefined,
      revision,
      sequence,
      onInput: (agent, input) => inputs.push({ agent, input }),
    }),
    policy: CHAT_PROFILES["general-chat"],
  };
  const preset: TeamPreset = {
    teamId: "solo",
    entryBotId: first,
    memberBotIds: [first],
  };
  const agentRuntime = {
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
    catalog: createBotCatalog([firstBot, secondBot]),
    presets: [preset],
    onSnapshot: () => undefined,
    onTeamError: (error) => errors.push(error),
  });
  return { app, store, conversationId, inputs, errors };
}

describe("ConversationApplication Bot selection", () => {
  it("creates an independent single-Bot conversation from a Bot selection", async () => {
    const harness = createHarness({});

    const snapshot = await harness.app.createConversation(harness.conversationId, {
      kind: "bot",
      botId: first,
    });

    expect(snapshot.activeAgentId).toBe(first);
    expect(snapshot.participantAgentIds).toEqual([first]);
    expect(snapshot.bots).toEqual([{ id: first, name: "第一个", role: "first" }]);
  });

  it("keeps an existing conversation's active Bot when create is called again", async () => {
    const harness = createHarness({});
    await harness.app.createConversation(harness.conversationId, {
      kind: "bot",
      botId: first,
    });
    await harness.app.send(first, harness.conversationId, { text: "你好", images: [] }, "token");

    const snapshot = await harness.app.createConversation(harness.conversationId, {
      kind: "bot",
      botId: second,
    });

    expect(snapshot.activeAgentId).toBe(first);
    expect(snapshot.participantAgentIds).toEqual([first]);
    expect(harness.inputs.map((recorded) => recorded.agent)).toEqual([first]);
  });

  it("rejects a handoff from a single-participant conversation", async () => {
    const harness = createHarness({
      result: { kind: "handoff", to: second, task: "请接管" },
    });

    await expect(
      harness.app.sendTeamMessage(
        "solo",
        harness.conversationId,
        { text: "开始", images: [] },
        "token",
      ),
    ).rejects.toThrow("Bot 无法发现交接目标：first -> second");

    const snapshot = await harness.app.getSnapshot(harness.conversationId);
    expect(snapshot.messages.map((message) => message.audience?.kind)).toEqual(["user", "user"]);
    expect(snapshot.activeAgentId).toBe(first);
  });

  it("rejects an unknown Bot selection", async () => {
    const harness = createHarness({});

    await expect(
      harness.app.createConversation(harness.conversationId, {
        kind: "bot",
        botId: "missing",
      }),
    ).rejects.toThrow("Bot 未注册：missing");
  });

  it("lists only Bot identities, not prompts or tools", () => {
    const harness = createHarness({});
    expect(harness.app.listBots()).toEqual([
      {
        id: first,
        name: "第一个",
        role: "first",
        responsibility: "first",
        owns: ["first"],
      },
      {
        id: second,
        name: "第二个",
        role: "second",
        responsibility: "second",
        owns: ["second"],
      },
    ]);
  });
});

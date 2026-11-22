import { describe, expect, it, vi } from "vitest";
import { ConversationApplication } from "../../src/conversation/application";
import type { ConversationBot } from "../../src/conversation/bots/types";
import { CHAT_PROFILES } from "../../src/conversation/profiles/registry";
import { agentId } from "../../src/core/agent/definition";
import type { AgentRuntime } from "../../src/core/agent/runtime";
import { createBotCatalog } from "../../src/core/bot/catalog";
import type { StepRunner, TurnHandoff } from "../../src/core/session/contracts";
import type { TeamPreset } from "../../src/core/team/preset";
import { MemoryConversationStore } from "../../src/core/transcript/memoryStore";

const first = agentId("first");
const second = agentId("second");

type InputRecord = { agent: string; text: string };

function scriptedRunner({
  inputs,
  textFor,
  handoff,
}: {
  inputs: InputRecord[];
  textFor: (agent: string) => string;
  handoff?: TurnHandoff;
}): StepRunner {
  return {
    async run(step, context, signal) {
      if (signal.aborted) return { outcome: "aborted" };
      inputs.push({
        agent: step.agentId,
        text: step.handoff?.task ?? step.input?.text ?? "",
      });
      await context.events.append({ type: "text-start", partId: "text" });
      await context.events.append({
        type: "text-delta",
        partId: "text",
        delta: textFor(step.agentId),
      });
      await context.events.append({ type: "text-end", partId: "text" });
      const ownHandoff = handoff !== undefined && step.agentId === first ? handoff : undefined;
      return {
        outcome: "completed",
        finishReason: "stop",
        ...(ownHandoff === undefined ? {} : { handoff: ownHandoff }),
      };
    },
  };
}

function createHarness({ handoff }: { handoff?: TurnHandoff } = {}) {
  const store = new MemoryConversationStore();
  const conversationId = "selection-conversation";
  const inputs: InputRecord[] = [];
  const errors: unknown[] = [];
  const runner = scriptedRunner({
    inputs,
    handoff,
    textFor: (agent) => (agent === first ? "第一个回复" : "第二个回复"),
  });

  const bot = (id: typeof first): ConversationBot => ({
    id,
    identity: {
      name: id === first ? "第一个" : "第二个",
      role: id === first ? "first" : "second",
      responsibility: id,
      owns: [id],
    },
    discovery: { visibleTo: { kind: "team", teamId: "solo" } },
    domain: "conversation",
    executor: {
      startRun: async () => {
        throw new Error("Session 底座不应再调用 startRun");
      },
      prepare: async () => {
        throw new Error("注入的 StepRunner 不需要 prepare");
      },
    },
    policy: CHAT_PROFILES["general-chat"],
  });
  const preset: TeamPreset = {
    teamId: "solo",
    entryBotId: first,
    memberBotIds: [first],
  };
  const dualPreset: TeamPreset = {
    teamId: "dual",
    entryBotId: first,
    memberBotIds: [first, second],
  };
  const agentRuntime = {
    assertRegistered: vi.fn(),
    assertTeamMembers: vi.fn(),
    dispose: vi.fn(),
    cancel: vi.fn(),
    waitForRun: vi.fn(async () => undefined),
    getRun: vi.fn(async () => undefined),
    readEventsForRun: vi.fn(async () => []),
    activeRunCount: 0,
    chatContextWindow: () => undefined,
  } as unknown as AgentRuntime;
  const app = new ConversationApplication({
    agentRuntime,
    store,
    catalog: createBotCatalog([bot(first), bot(second)]),
    presets: [preset, dualPreset],
    stepRunner: runner,
    onSnapshot: () => undefined,
    onTeamError: (error) => errors.push(error),
  });
  return { app, store, conversationId, inputs, errors };
}

describe("ConversationApplication Bot selection", () => {
  it("creates an independent single-Bot conversation from a Bot selection", async () => {
    const harness = createHarness();

    const snapshot = await harness.app.createConversation(harness.conversationId, {
      kind: "bot",
      botId: first,
    });

    expect(snapshot.activeAgentId).toBe(first);
    expect(snapshot.participantAgentIds).toEqual([first]);
    expect(snapshot.bots).toEqual([{ id: first, name: "第一个", role: "first" }]);
  });

  it("rejects a different selection without rewriting an existing conversation", async () => {
    const harness = createHarness();
    await harness.app.createConversation(harness.conversationId, {
      kind: "bot",
      botId: first,
    });
    await harness.app.send(first, harness.conversationId, { text: "你好", images: [] }, "token");

    await expect(
      harness.app.createConversation(harness.conversationId, {
        kind: "bot",
        botId: second,
      }),
    ).rejects.toThrow("会话已存在且 Bot 参与者不同");

    const snapshot = await harness.app.getSnapshot(harness.conversationId);
    expect(snapshot.activeAgentId).toBe(first);
    expect(snapshot.participantAgentIds).toEqual([first]);
    expect(harness.inputs.map((recorded) => recorded.agent)).toEqual([first]);
  });

  it("rejects an explicit Bot that differs from the conversation's active Bot", async () => {
    const harness = createHarness();
    await harness.app.createConversation(harness.conversationId, {
      kind: "bot",
      botId: first,
    });

    await expect(
      harness.app.send(second, harness.conversationId, { text: "你好", images: [] }, "token"),
    ).rejects.toThrow("会话当前由 first 接待，不能直接切换到 second");

    const snapshot = await harness.app.getSnapshot(harness.conversationId);
    expect(snapshot.activeAgentId).toBe(first);
    expect(snapshot.participantAgentIds).toEqual([first]);
  });

  it("rejects a team send that conflicts with the conversation's participants", async () => {
    const harness = createHarness();
    await harness.app.createConversation(harness.conversationId, {
      kind: "bot",
      botId: first,
    });

    await expect(
      harness.app.sendTeamMessage(
        "dual",
        harness.conversationId,
        { text: "开始", images: [] },
        "token",
      ),
    ).rejects.toThrow("会话已存在且 Bot 参与者不同");

    const snapshot = await harness.app.getSnapshot(harness.conversationId);
    expect(snapshot.activeAgentId).toBe(first);
    expect(snapshot.participantAgentIds).toEqual([first]);
  });

  it("rejects a handoff from a single-participant conversation", async () => {
    const harness = createHarness({
      handoff: { toAgentId: second, task: "请接管" },
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
    const harness = createHarness();

    await expect(
      harness.app.createConversation(harness.conversationId, {
        kind: "bot",
        botId: "missing",
      }),
    ).rejects.toThrow("Bot 未注册：missing");
  });

  it("lists only Bot identities, not prompts or tools", () => {
    const harness = createHarness();
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

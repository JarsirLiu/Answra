import type { TextStreamPart, ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { ConversationAgentInput } from "../../src/bots/general/agent";
import type { ConversationBot } from "../../src/conversation/bots/types";
import { CHAT_PROFILES } from "../../src/conversation/profiles/registry";
import {
  type ConversationStepBindingOptions,
  createConversationStepBinding,
} from "../../src/conversation/stepBinding";
import type {
  AgentExecutor,
  AgentId,
  AgentModelRequest,
  BotTurnResult,
} from "../../src/core/agent/definition";
import { agentId } from "../../src/core/agent/definition";
import {
  ProviderStepRunner,
  type ProviderStepRunnerOptions,
} from "../../src/core/agent/providerStepRunner";
import { createBotCatalog } from "../../src/core/bot/catalog";
import type { StepStart } from "../../src/core/session/contracts";
import { MemorySessionJournal } from "../../src/core/session/memoryJournal";
import { SessionStepExecutor } from "../../src/core/session/stepExecutor";
import {
  TEST_SESSION_ID,
  TEST_STEP_ID,
  TEST_TURN_ID,
  TEST_TURN_RUNTIME,
  userMessage,
} from "../core/session/fixtures";

const MODEL_REQUEST: AgentModelRequest = {
  system: "base",
  messages: [{ role: "user", content: "hello" }],
};

const candidate = agentId("candidate");
const intake = agentId("intake");

function createBot(
  id: AgentId,
  name: string,
  executor: AgentExecutor<ConversationAgentInput>,
): ConversationBot {
  return {
    id,
    identity: {
      name,
      role: id,
      responsibility: `${name} 的职责`,
      owns: [id],
    },
    discovery: { visibleTo: { kind: "team", teamId: "interview" } },
    domain: "conversation",
    executor,
    policy: CHAT_PROFILES["general-chat"],
  };
}

function createExecutor({
  result,
  onPrepare,
}: {
  result?: BotTurnResult;
  onPrepare?: (input: ConversationAgentInput) => void;
} = {}): AgentExecutor<ConversationAgentInput> {
  return {
    prepare: async (input) => {
      onPrepare?.(input);
      return MODEL_REQUEST;
    },
    ...(result ? { result: async () => result } : {}),
  };
}

function stepStart(overrides: Partial<StepStart> = {}): StepStart {
  return {
    sessionId: TEST_SESSION_ID,
    turnId: TEST_TURN_ID,
    stepId: TEST_STEP_ID,
    index: 0,
    agentId: intake,
    source: "user",
    messageId: "assistant-intake",
    ...overrides,
  };
}

function completedParts(text: string): unknown[] {
  return [
    { type: "start" },
    { type: "start-step", warnings: [] },
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", text },
    { type: "text-end", id: "text-1" },
    { type: "finish-step", finishReason: "stop", usage: { inputTokens: 12, outputTokens: 3 } },
    { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 12, outputTokens: 3 } },
  ];
}

function partsStream(parts: readonly unknown[]): AsyncIterable<TextStreamPart<ToolSet>> {
  return (async function* () {
    for (const part of parts) yield part as TextStreamPart<ToolSet>;
  })();
}

type ConversationRunnerOptions = ConversationStepBindingOptions &
  Omit<ProviderStepRunnerOptions, "prepare" | "resolveHandoff">;

function runnerOptions(
  overrides: Partial<ConversationRunnerOptions> = {},
): ConversationRunnerOptions {
  return {
    catalog: createBotCatalog([
      createBot(candidate, "候选人", createExecutor()),
      createBot(intake, "面试向导", createExecutor()),
    ]),
    workspaceRoot: () => "D:/workspace",
    endpoint: { baseUrl: "http://127.0.0.1:1234/v1", model: "test.chat" },
    ...overrides,
  };
}

function createRunner(options: ConversationRunnerOptions): ProviderStepRunner {
  const binding = createConversationStepBinding(options);
  return new ProviderStepRunner({
    endpoint: options.endpoint,
    prepare: binding.prepare,
    resolveHandoff: binding.resolveHandoff,
    ...(options.contextManager === undefined ? {} : { contextManager: options.contextManager }),
    ...(options.tokenProvider === undefined ? {} : { tokenProvider: options.tokenProvider }),
    ...(options.stream === undefined ? {} : { stream: options.stream }),
  });
}

describe("Conversation step binding", () => {
  it("uses the handoff task as the target Bot input and keeps the Turn input available", async () => {
    let prepared: ConversationAgentInput | undefined;
    const options = runnerOptions({
      catalog: createBotCatalog([
        createBot(candidate, "候选人", createExecutor()),
        createBot(intake, "面试向导", createExecutor({ onPrepare: (input) => (prepared = input) })),
      ]),
    });
    const binding = createConversationStepBinding(options);

    await binding.prepare(
      stepStart({
        input: userMessage("user-1", "帮我准备面试"),
        handoff: {
          fromAgentId: candidate,
          task: "请接管整理并继续追问。",
          sourceMessageId: "assistant-candidate",
        },
      }),
      new AbortController().signal,
      { toolOutput: () => undefined },
    );

    expect(prepared).toMatchObject({
      conversationId: TEST_SESSION_ID,
      runId: TEST_STEP_ID,
      request: { text: "请接管整理并继续追问。", images: [] },
      viewerAgentId: intake,
      workspaceRoot: "D:/workspace",
    });
    expect(prepared?.agentNames?.get(candidate)).toBe("候选人");
  });

  it("falls back to the Turn user input when there is no handoff", async () => {
    let prepared: ConversationAgentInput | undefined;
    const binding = createConversationStepBinding(
      runnerOptions({
        catalog: createBotCatalog([
          createBot(
            intake,
            "面试向导",
            createExecutor({ onPrepare: (input) => (prepared = input) }),
          ),
        ]),
      }),
    );

    await binding.prepare(
      stepStart({
        input: userMessage("user-1", "直接回答"),
      }),
      new AbortController().signal,
      { toolOutput: () => undefined },
    );

    expect(prepared?.request).toEqual({ text: "直接回答", images: [] });
  });

  it("maps the Bot result to a Turn handoff without starting another run", async () => {
    const binding = createConversationStepBinding(
      runnerOptions({
        catalog: createBotCatalog([
          createBot(
            intake,
            "面试向导",
            createExecutor({
              result: { kind: "handoff", to: candidate, task: "请继续" },
            }),
          ),
        ]),
      }),
    );

    await expect(binding.resolveHandoff(stepStart({ input: userMessage() }))).resolves.toEqual({
      toAgentId: candidate,
      task: "请继续",
    });
  });

  it("rejects a step without handoff or Turn input", async () => {
    const binding = createConversationStepBinding(runnerOptions());

    await expect(
      binding.prepare(stepStart(), new AbortController().signal, {
        toolOutput: () => undefined,
      }),
    ).rejects.toThrow("Step 缺少输入");
  });

  it("runs the real StepExecutor path and returns the target Bot handoff", async () => {
    const journal = new MemorySessionJournal();
    const onPrepare = vi.fn();
    const runner = createRunner(
      runnerOptions({
        catalog: createBotCatalog([
          createBot(
            intake,
            "面试向导",
            createExecutor({
              onPrepare,
              result: { kind: "handoff", to: candidate, task: "请继续" },
            }),
          ),
        ]),
        stream: () => partsStream(completedParts("done")),
      }),
    );
    const executor = new SessionStepExecutor({ journal, runner });

    const result = await executor.run(
      stepStart({
        input: userMessage("user-1", "帮我准备面试"),
        handoff: {
          fromAgentId: candidate,
          task: "请接管整理并继续追问。",
          sourceMessageId: "assistant-candidate",
        },
      }),
      TEST_TURN_RUNTIME,
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      outcome: "completed",
      finishReason: "stop",
      handoff: { toAgentId: candidate, task: "请继续" },
    });
    expect(onPrepare).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ text: "请接管整理并继续追问。" }),
      }),
    );
    const events = await journal.readAfter(TEST_SESSION_ID, 0);
    expect(events.map((event) => event.event.type)).toEqual([
      "step-started",
      "start",
      "text-start",
      "text-end",
      "finish",
      "step-finished",
      "context-usage-changed",
    ]);
  });
});

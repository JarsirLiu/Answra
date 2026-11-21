import { type ConversationMessage, MANUAL_COMPACTION_INSTRUCTIONS_MAX_CHARS } from "@answra/shared";
import type { AgentEvent, AgentEventEnvelope } from "@answra/shared/schema";
import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  type ContextBudgetPolicy,
  ContextLimitExceededError,
} from "../../../src/core/context/budget";
import {
  ContextCompactor,
  type ContextSummaryGenerator,
} from "../../../src/core/context/compaction/compactor";
import { ContextPreparation } from "../../../src/core/context/preparation";
import type { ToolResultPruningPolicy } from "../../../src/core/context/pruning/policy";
import { PRUNED_TOOL_RESULT_TEXT } from "../../../src/core/context/pruning/prune";
import { estimateContextRequestTokens } from "../../../src/core/context/tokenEstimate";
import { READ_TOOL_NAME } from "../../../src/core/tool/names";
import type { ContextCheckpoint } from "../../../src/core/transcript/contextCheckpoint";
import { MemoryConversationStore } from "../../../src/core/transcript/memoryStore";

const SMALL_BUDGET: ContextBudgetPolicy = {
  contextWindow: 1_050,
  maxOutputTokens: 50,
  safetyTokens: 100,
  fixedOverheadTokens: 100,
  compactionBuffer: 300,
  pruneAt: 500,
  pruneTarget: 100,
  minPruneSaving: 400,
  postCompactTarget: 800,
  summaryMaxTokens: 200,
};

const MODEL_REQUEST = {
  system: "x".repeat(3_000),
  messages: [],
};

const NO_PROTECTION: ToolResultPruningPolicy = {
  clearableToolNames: [READ_TOOL_NAME],
  protectedRecentResults: 0,
  protectedRecentMessages: 0,
};

const PRUNE_ONLY_BUDGET: ContextBudgetPolicy = {
  contextWindow: 3_000,
  maxOutputTokens: 50,
  safetyTokens: 100,
  fixedOverheadTokens: 100,
  compactionBuffer: 1_000,
  pruneAt: 500,
  pruneTarget: 100,
  minPruneSaving: 400,
  postCompactTarget: 2_000,
  summaryMaxTokens: 500,
};

const REBUILD_BUDGET: ContextBudgetPolicy = {
  contextWindow: 3_000,
  maxOutputTokens: 50,
  safetyTokens: 100,
  fixedOverheadTokens: 100,
  compactionBuffer: 1_750,
  pruneAt: 500,
  pruneTarget: 100,
  minPruneSaving: 400,
  postCompactTarget: 2_000,
  summaryMaxTokens: 500,
};

const CLEAR_TAIL_BUDGET: ContextBudgetPolicy = {
  contextWindow: 3_000,
  maxOutputTokens: 50,
  safetyTokens: 100,
  fixedOverheadTokens: 100,
  compactionBuffer: 1_000,
  pruneAt: 500,
  pruneTarget: 10,
  minPruneSaving: 400,
  postCompactTarget: 40,
  summaryMaxTokens: 500,
};

function message(id: string, text: string): ConversationMessage {
  return {
    id,
    role: "user",
    text,
    images: [],
    status: "complete",
  };
}

function checkpoint(throughMessageId: string): ContextCheckpoint {
  return {
    summary: "旧摘要",
    throughMessageId,
    createdAt: "2026-11-14T10:00:00.000Z",
    messageCount: 2,
  };
}

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
    occurredAt: "2026-11-14T10:00:00.000Z",
    event,
  };
}

async function preparedStore(): Promise<MemoryConversationStore> {
  const store = new MemoryConversationStore();
  await store.create("conversation-1");
  await store.appendUserMessage("conversation-1", message("m1", "旧需求"));
  await store.appendUserMessage("conversation-1", message("m2", "保留需求"));
  return store;
}

function preparation(
  store: MemoryConversationStore,
  options: {
    generate?: ContextSummaryGenerator;
    budget?: ContextBudgetPolicy;
    contextWindow?: () => number | undefined;
    toolResultPruning?: ToolResultPruningPolicy;
    now?: () => Date;
  } = {},
): ContextPreparation {
  const compactor = new ContextCompactor({
    store,
    generate: options.generate ?? (async () => "压缩后的摘要"),
    ...(options.now ? { now: options.now } : {}),
  });
  const budget = options.budget ?? (options.contextWindow === undefined ? SMALL_BUDGET : undefined);
  return new ContextPreparation({
    compactor,
    contextStateStore: store,
    ...(budget === undefined ? {} : { budget }),
    ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
    ...(options.toolResultPruning ? { toolResultPruning: options.toolResultPruning } : {}),
  });
}

function toolResult(value: string, toolCallId: string): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName: READ_TOOL_NAME,
        output: { type: "text", value },
      },
    ],
  };
}

function toolText(message: ModelMessage | undefined): string {
  if (message?.role !== "tool") throw new Error("expected tool message");
  const part = message.content[0];
  if (part?.type !== "tool-result" || part.output.type !== "text") {
    throw new Error("expected text tool result");
  }
  return part.output.value;
}

describe("ContextPreparation", () => {
  it("compacts from the final request estimate and rebuilds before returning", async () => {
    const store = await preparedStore();
    const rebuild = vi.fn(async () => ({ system: "small", messages: [] }));

    const result = await preparation(store).prepareRequest({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: MODEL_REQUEST,
      rebuild,
    });

    expect(rebuild).toHaveBeenCalledOnce();
    expect(result).toEqual({ system: "small", messages: [] });
    expect((await store.loadContextState("conversation-1"))?.checkpoints.at(-1)).toMatchObject({
      throughMessageId: "m2",
      retainedUserMessages: [{ id: "m1" }, { id: "m2" }],
    });
  });

  it("auto-compacts a single user turn while its tool loop is still running", async () => {
    const store = new MemoryConversationStore();
    await store.create("conversation-1");
    await store.beginRun("conversation-1", "run-1", message("m1", "修复这个 bug"));
    for (let index = 0; index < 6; index += 1) {
      const toolCallId = `call-${index}`;
      await store.applyAgentEvent(
        "conversation-1",
        eventEnvelope("conversation-1", "run-1", index * 2 + 1, {
          type: "tool-call",
          toolCallId,
          toolName: READ_TOOL_NAME,
          input: { path: `src/file-${index}.ts` },
        }),
      );
      await store.applyAgentEvent(
        "conversation-1",
        eventEnvelope("conversation-1", "run-1", index * 2 + 2, {
          type: "tool-result",
          toolCallId,
          output: `文件内容 ${index}`,
        }),
      );
    }
    const generate = vi.fn<ContextSummaryGenerator>(async ({ prompt }) => {
      expect(prompt).toContain("文件内容 5");
      return "工具循环摘要";
    });
    const rebuild = vi.fn(async () => ({ system: "small", messages: [] }));

    const result = await preparation(store, { generate }).prepareRequest({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "x".repeat(4_000), messages: [] },
      rebuild,
    });

    expect(result).toEqual({ system: "small", messages: [] });
    expect(generate).toHaveBeenCalledOnce();
    expect(rebuild).toHaveBeenCalledOnce();
    expect((await store.loadContextState("conversation-1"))?.checkpoints.at(-1)).toMatchObject({
      throughMessageId: "run-1",
      retainedUserMessages: [{ id: "m1" }],
    });
  });

  it("summarizes the transcript with the merged pruning watermark", async () => {
    const store = new MemoryConversationStore();
    await store.create("conversation-1");
    await store.beginRun("conversation-1", "run-1", message("m1", "读取文件"));
    await store.applyAgentEvent(
      "conversation-1",
      eventEnvelope("conversation-1", "run-1", 1, {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: READ_TOOL_NAME,
        input: { path: "src/file.ts" },
      }),
    );
    await store.applyAgentEvent(
      "conversation-1",
      eventEnvelope("conversation-1", "run-1", 2, {
        type: "tool-result",
        toolCallId: "call-1",
        output: "RAW_OLD_RESULT",
      }),
    );
    await store.saveContextState("conversation-1", {
      checkpoints: [],
      prunedToolCallIds: ["call-1"],
    });
    const generate = vi.fn<ContextSummaryGenerator>(async ({ prompt }) => {
      expect(prompt).toContain(`[工具结果] ${PRUNED_TOOL_RESULT_TEXT}`);
      expect(prompt).toContain("src/file.ts");
      expect(prompt).not.toContain("RAW_OLD_RESULT");
      return "清理后摘要";
    });

    const result = await preparation(store, { generate }).compactNow({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "small", messages: [] },
      rebuild: async () => ({ system: "small", messages: [] }),
    });

    expect(result.status).toBe("compacted");
    expect(generate).toHaveBeenCalledOnce();
  });

  it("summarizes newly pruned tool results instead of the raw transcript", async () => {
    const store = new MemoryConversationStore();
    await store.create("conversation-1");
    await store.beginRun("conversation-1", "run-1", message("m1", "读取文件"));
    for (let index = 0; index < 6; index += 1) {
      const toolCallId = `call-${index}`;
      await store.applyAgentEvent(
        "conversation-1",
        eventEnvelope("conversation-1", "run-1", index * 2 + 1, {
          type: "tool-call",
          toolCallId,
          toolName: READ_TOOL_NAME,
          input: { path: `src/file-${index}.ts` },
        }),
      );
      await store.applyAgentEvent(
        "conversation-1",
        eventEnvelope("conversation-1", "run-1", index * 2 + 2, {
          type: "tool-result",
          toolCallId,
          output: `RAW_RESULT_${index}`,
        }),
      );
    }
    const generate = vi.fn<ContextSummaryGenerator>(async ({ prompt }) => {
      expect(prompt).toContain(PRUNED_TOOL_RESULT_TEXT);
      expect(prompt).toContain("src/file-0.ts");
      expect(prompt).not.toContain("RAW_RESULT_0");
      return "清理后摘要";
    });
    const messages = Array.from({ length: 6 }, (_, index) =>
      toolResult("r".repeat(400), `call-${index}`),
    );

    const result = await preparation(store, {
      generate,
      toolResultPruning: NO_PROTECTION,
    }).compactNow({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "x".repeat(4_000), messages },
      rebuild: async () => ({ system: "small", messages: [] }),
    });

    expect(result.status).toBe("compacted");
    expect(generate).toHaveBeenCalledOnce();
    expect((await store.loadContextState("conversation-1"))?.prunedToolCallIds).toEqual([
      ...Array.from({ length: 6 }, (_, index) => `call-${index}`),
    ]);
  });

  it("protects retained user messages and the summary when trimming the rebuilt request", async () => {
    const store = await preparedStore();
    const rebuilt = {
      system: "",
      messages: [
        { role: "user" as const, content: "原始需求一" },
        { role: "user" as const, content: "原始需求二" },
        { role: "user" as const, content: "压缩摘要" },
        { role: "user" as const, content: `旧尾段${"t".repeat(2_000)}` },
        { role: "assistant" as const, content: `旧回复${"a".repeat(2_000)}` },
        { role: "user" as const, content: "当前请求" },
      ],
    };

    const result = await preparation(store, { budget: CLEAR_TAIL_BUDGET }).recoverRequest({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "", messages: [] },
      rebuild: async () => rebuilt,
    });

    expect(result?.messages.map((message) => message.content)).toEqual([
      "原始需求一",
      "原始需求二",
      "压缩摘要",
      "当前请求",
    ]);
  });

  it("trims the oldest complete turn when compaction cannot reduce the request", async () => {
    const store = await preparedStore();
    await store.saveContextState("conversation-1", {
      checkpoints: [checkpoint("m2")],
    });
    const generate = vi.fn(async () => "不应调用");
    const messages: ModelMessage[] = [
      { role: "user", content: "o".repeat(400) },
      { role: "assistant", content: "a".repeat(400) },
      { role: "user", content: "current" },
    ];

    const result = await preparation(store, {
      generate,
    }).prepareRequest({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "x".repeat(3_000), messages },
      rebuild: async () => {
        throw new Error("不应重建");
      },
    });

    expect(result.messages).toEqual([{ role: "user", content: "current" }]);
    expect(generate).not.toHaveBeenCalled();
  });

  it("fails closed when the current request alone exceeds the input limit", async () => {
    const store = await preparedStore();
    await store.saveContextState("conversation-1", {
      checkpoints: [checkpoint("m2")],
    });
    const generate = vi.fn(async () => "不应调用");

    await expect(
      preparation(store, {
        generate,
      }).prepareRequest({
        conversationId: "conversation-1",
        getAccessToken: async () => "token",
        modelRequest: { system: "x".repeat(3_500), messages: [] },
        rebuild: async () => {
          throw new Error("不应重建");
        },
      }),
    ).rejects.toBeInstanceOf(ContextLimitExceededError);

    expect(generate).not.toHaveBeenCalled();
  });

  it("prunes old tool results before compaction and skips rebuild below the compaction line", async () => {
    const store = await preparedStore();
    await store.saveContextState("conversation-1", {
      checkpoints: [checkpoint("m2")],
    });
    const messages = Array.from({ length: 6 }, (_, index) =>
      toolResult("r".repeat(400), `call-${index}`),
    );
    const rebuild = vi.fn(async () => ({ system: "", messages: [] }));

    const result = await preparation(store, { toolResultPruning: NO_PROTECTION }).prepareRequest({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "", messages },
      rebuild,
    });

    expect(toolText(result.messages[0])).toBe(PRUNED_TOOL_RESULT_TEXT);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("keeps the original request when pruning saves less than the threshold", async () => {
    const store = await preparedStore();
    const messages = [toolResult("small".repeat(8), "call-1")];
    const rebuild = vi.fn(async () => ({ system: "", messages: [] }));

    const result = await preparation(store, {
      budget: PRUNE_ONLY_BUDGET,
      toolResultPruning: NO_PROTECTION,
    }).prepareRequest({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "x".repeat(2_000), messages },
      rebuild,
    });

    expect(result.messages).toBe(messages);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("prunes again after compaction rebuild restores the full tool results", async () => {
    const store = await preparedStore();
    const generate = vi.fn(async () => "压缩后的摘要");
    const messages = Array.from({ length: 5 }, (_, index) =>
      toolResult("r".repeat(400), `call-${index}`),
    );
    const rebuilt = { system: "x".repeat(5_000), messages };
    const rebuild = vi.fn(async () => rebuilt);

    const result = await preparation(store, {
      budget: REBUILD_BUDGET,
      generate,
      toolResultPruning: NO_PROTECTION,
    }).prepareRequest({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "x".repeat(5_000), messages },
      rebuild,
    });

    expect(generate).toHaveBeenCalledOnce();
    expect(rebuild).toHaveBeenCalledOnce();
    expect(result.messages.map(toolText)).toEqual(
      Array.from({ length: 5 }, () => PRUNED_TOOL_RESULT_TEXT),
    );
  });

  it("uses the usage anchor to reach the prune trigger below the raw estimate", async () => {
    const store = await preparedStore();
    const messages = Array.from({ length: 3 }, (_, index) =>
      toolResult("r".repeat(400), `call-${index}`),
    );
    const request = { system: "x".repeat(600), messages };
    const estimatedTokens = estimateContextRequestTokens(request);
    await store.saveContextState("conversation-1", {
      checkpoints: [],
      usageAnchor: {
        inputTokens: estimatedTokens * 2,
        estimatedTokens,
        createdAt: "2026-11-14T10:00:00.000Z",
      },
    });

    const result = await preparation(store, {
      budget: PRUNE_ONLY_BUDGET,
      toolResultPruning: NO_PROTECTION,
    }).prepareRequest({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: request,
      rebuild: async () => {
        throw new Error("不应重建");
      },
    });

    expect(result.messages.map(toolText)).toEqual(
      Array.from({ length: 3 }, () => PRUNED_TOOL_RESULT_TEXT),
    );
  });

  it("saves the first-step usage as the next anchor after a completed run", async () => {
    const store = await preparedStore();
    const preparationInstance = preparation(store, { budget: PRUNE_ONLY_BUDGET });
    const result = await preparationInstance.prepareRequest({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "", messages: [{ role: "user", content: "hi" }] },
      rebuild: async () => {
        throw new Error("不应重建");
      },
    });

    await preparationInstance.recordRunEvent("conversation-1", {
      type: "step-finished",
      stepId: "step-0",
      index: 0,
      state: "completed",
      usage: { inputTokens: 123, outputTokens: 1 },
    });
    await preparationInstance.recordRunEvent("conversation-1", {
      type: "run-state-changed",
      state: "completed",
      attempt: 1,
    });

    expect(await store.loadContextState("conversation-1")).toMatchObject({
      usageAnchor: {
        inputTokens: 123,
        estimatedTokens: estimateContextRequestTokens(result),
      },
    });
  });

  it("ignores usage from later steps so a previous anchor stays valid", async () => {
    const store = await preparedStore();
    const previousAnchor = {
      inputTokens: 500,
      estimatedTokens: 400,
      createdAt: "2026-11-14T10:00:00.000Z",
    };
    await store.saveContextState("conversation-1", {
      checkpoints: [],
      usageAnchor: previousAnchor,
    });
    const preparationInstance = preparation(store, { budget: PRUNE_ONLY_BUDGET });
    await preparationInstance.prepareRequest({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "", messages: [{ role: "user", content: "hi" }] },
      rebuild: async () => {
        throw new Error("不应重建");
      },
    });

    await preparationInstance.recordRunEvent("conversation-1", {
      type: "step-finished",
      stepId: "step-1",
      index: 1,
      state: "completed",
      usage: { inputTokens: 999, outputTokens: 1 },
    });
    await preparationInstance.recordRunEvent("conversation-1", {
      type: "run-state-changed",
      state: "completed",
      attempt: 1,
    });

    expect((await store.loadContextState("conversation-1"))?.usageAnchor).toEqual(previousAnchor);
  });

  it("persists context usage from every context usage event", async () => {
    const store = await preparedStore();
    const preparationInstance = preparation(store, { budget: PRUNE_ONLY_BUDGET });
    await preparationInstance.prepareRequest({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "", messages: [{ role: "user", content: "hi" }] },
      rebuild: async () => {
        throw new Error("不应重建");
      },
    });

    await preparationInstance.recordRunEvent("conversation-1", {
      type: "context-usage-changed",
      usedTokens: 2_700,
    });

    expect((await store.loadContextState("conversation-1"))?.usage?.usedTokens).toBe(2_700);
    expect((await store.load("conversation-1")).contextUsage?.usedTokens).toBe(2_700);
  });

  it("clears a stale anchor when a projection-changing run completes without usage", async () => {
    const store = await preparedStore();
    const messages = Array.from({ length: 3 }, (_, index) =>
      toolResult("r".repeat(400), `call-${index}`),
    );
    const request = { system: "x".repeat(600), messages };
    const estimatedTokens = estimateContextRequestTokens(request);
    await store.saveContextState("conversation-1", {
      checkpoints: [],
      usageAnchor: {
        inputTokens: estimatedTokens * 2,
        estimatedTokens,
        createdAt: "2026-11-14T10:00:00.000Z",
      },
    });
    const preparationInstance = preparation(store, {
      budget: PRUNE_ONLY_BUDGET,
      toolResultPruning: NO_PROTECTION,
    });

    await preparationInstance.prepareRequest({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: request,
      rebuild: async () => {
        throw new Error("不应重建");
      },
    });
    await preparationInstance.recordRunEvent("conversation-1", {
      type: "run-state-changed",
      state: "completed",
      attempt: 1,
    });

    expect((await store.loadContextState("conversation-1"))?.usageAnchor).toBeUndefined();
  });

  it("uses the endpoint context window when no fixed budget is provided", async () => {
    const store = await preparedStore();
    const generate = vi.fn(async () => "压缩后的摘要");

    const result = await preparation(store, {
      contextWindow: () => 10_000,
      generate,
    }).prepareRequest({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "x".repeat(40_000), messages: [] },
      rebuild: async () => ({ system: "small", messages: [] }),
    });

    expect(generate).toHaveBeenCalledOnce();
    expect(result).toEqual({ system: "small", messages: [] });
  });

  it("does not publish estimated context usage before a model response", async () => {
    const store = await preparedStore();
    const onStatus = vi.fn();
    const messages = Array.from({ length: 6 }, (_, index) =>
      toolResult("r".repeat(400), `call-${index}`),
    );

    const result = await preparation(store, { toolResultPruning: NO_PROTECTION }).prepareRequest({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "", messages },
      rebuild: async () => {
        throw new Error("不应重建");
      },
      onStatus,
    });

    const state = await store.loadContextState("conversation-1");
    const snapshot = await store.load("conversation-1");
    expect(state?.usage).toMatchObject({
      inputLimit: 800,
      compactAt: 750,
      pruneAt: 500,
      pruneTarget: 100,
    });
    expect(state?.usage).toMatchObject({
      usedTokens: estimateContextRequestTokens(result),
      source: "estimate",
    });
    expect(state?.pruning).toMatchObject({ trigger: "auto", prunedCount: expect.any(Number) });
    expect(state?.pruning?.savedTokens).toBeGreaterThan(0);
    expect(snapshot.contextUsage).toEqual(state?.usage);
    expect(snapshot.contextPruning).toEqual(state?.pruning);
    expect(onStatus).toHaveBeenCalledOnce();
  });

  it("keeps the latest provider usage when preparing the next request", async () => {
    const store = await preparedStore();
    const instance = preparation(store, { toolResultPruning: NO_PROTECTION });
    const inputUsage = {
      contextWindow: 1_050,
      usedTokens: 417,
      inputLimit: 800,
      compactAt: 750,
      pruneAt: 500,
      pruneTarget: 100,
      updatedAt: "2026-11-19T10:00:00.000Z",
      source: "provider" as const,
    };
    await store.saveContextState("conversation-1", { checkpoints: [], usage: inputUsage });

    await instance.prepareRequest({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "x".repeat(600), messages: [] },
      rebuild: async () => {
        throw new Error("不应重建");
      },
    });

    expect((await store.loadContextState("conversation-1"))?.usage).toEqual(inputUsage);
  });

  it("clears a previous pruning status when the next request does not prune", async () => {
    const store = await preparedStore();
    const messages = Array.from({ length: 6 }, (_, index) =>
      toolResult("r".repeat(400), `call-${index}`),
    );
    const preparationInstance = preparation(store, { toolResultPruning: NO_PROTECTION });

    await preparationInstance.prepareRequest({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "", messages },
      rebuild: async () => {
        throw new Error("不应重建");
      },
    });
    expect((await store.loadContextState("conversation-1"))?.pruning).toBeDefined();

    await preparationInstance.prepareRequest({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "", messages: [] },
      rebuild: async () => {
        throw new Error("不应重建");
      },
    });

    expect((await store.loadContextState("conversation-1"))?.pruning).toBeUndefined();
  });

  it("keeps pruned results cleared on the next request instead of pruning them again", async () => {
    const store = await preparedStore();
    const messages = Array.from({ length: 6 }, (_, index) =>
      toolResult("r".repeat(400), `call-${index}`),
    );
    const preparationInstance = preparation(store, { toolResultPruning: NO_PROTECTION });
    const request = { system: "", messages };

    const first = await preparationInstance.prepareRequest({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: request,
      rebuild: async () => {
        throw new Error("不应重建");
      },
    });
    expect(first.messages.map(toolText)).toEqual(
      Array.from({ length: 6 }, () => PRUNED_TOOL_RESULT_TEXT),
    );
    expect((await store.loadContextState("conversation-1"))?.pruning).toMatchObject({
      prunedCount: 6,
    });

    const second = await preparationInstance.prepareRequest({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: request,
      rebuild: async () => {
        throw new Error("不应重建");
      },
    });

    expect(second.messages.map(toolText)).toEqual(
      Array.from({ length: 6 }, () => PRUNED_TOOL_RESULT_TEXT),
    );
    const state = await store.loadContextState("conversation-1");
    expect(state?.pruning).toBeUndefined();
    expect(state?.prunedToolCallIds).toEqual(
      Array.from({ length: 6 }, (_, index) => `call-${index}`),
    );
  });

  it("prunes only the results added after the previous batch", async () => {
    const store = await preparedStore();
    const oldMessages = Array.from({ length: 6 }, (_, index) =>
      toolResult("r".repeat(400), `old-${index}`),
    );
    const newMessages = Array.from({ length: 6 }, (_, index) =>
      toolResult("n".repeat(400), `new-${index}`),
    );
    const preparationInstance = preparation(store, { toolResultPruning: NO_PROTECTION });

    await preparationInstance.prepareRequest({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "", messages: oldMessages },
      rebuild: async () => {
        throw new Error("不应重建");
      },
    });

    const result = await preparationInstance.prepareRequest({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "", messages: [...oldMessages, ...newMessages] },
      rebuild: async () => {
        throw new Error("不应重建");
      },
    });

    expect(result.messages.map(toolText)).toEqual(
      Array.from({ length: 12 }, () => PRUNED_TOOL_RESULT_TEXT),
    );
    const state = await store.loadContextState("conversation-1");
    expect(state?.pruning).toMatchObject({ prunedCount: 6 });
    expect(state?.prunedToolCallIds).toEqual([
      ...Array.from({ length: 6 }, (_, index) => `old-${index}`),
      ...Array.from({ length: 6 }, (_, index) => `new-${index}`),
    ]);
  });

  it("compacts on demand below the automatic threshold and reports refreshed usage", async () => {
    const store = await preparedStore();
    const generate = vi.fn(async () => "手动压缩摘要");
    const rebuilt = { system: "small", messages: [] };
    const rebuild = vi.fn(async () => rebuilt);

    const result = await preparation(store, { generate }).compactNow({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "small", messages: [] },
      rebuild,
    });

    expect(result).toEqual({
      status: "compacted",
      usage: expect.objectContaining({
        usedTokens: estimateContextRequestTokens(rebuilt),
      }),
    });
    expect(generate).toHaveBeenCalledOnce();
    expect(rebuild).toHaveBeenCalledOnce();
    expect((await store.load("conversation-1")).messages).toHaveLength(2);
    expect((await store.loadContextState("conversation-1"))?.checkpoints.at(-1)).toMatchObject({
      throughMessageId: "m2",
    });
    expect((await store.loadContextState("conversation-1"))?.compaction).toMatchObject({
      state: "succeeded",
      trigger: "manual",
    });
  });

  it("replaces old provider usage with the post-compaction estimate", async () => {
    const store = await preparedStore();
    const rebuilt = { system: "small", messages: [] };
    const previousUsage = {
      contextWindow: 1_050,
      usedTokens: 212_300,
      inputLimit: 800,
      compactAt: 750,
      pruneAt: 500,
      pruneTarget: 100,
      source: "provider" as const,
      updatedAt: "2026-11-19T10:00:00.000Z",
    };
    await store.saveContextState("conversation-1", {
      checkpoints: [],
      usage: previousUsage,
    });

    const result = await preparation(store, { generate: async () => "压缩后的摘要" }).compactNow({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "small", messages: [] },
      rebuild: async () => rebuilt,
    });

    expect(result).toEqual({
      status: "compacted",
      usage: expect.objectContaining({
        usedTokens: estimateContextRequestTokens(rebuilt),
        source: "compaction",
      }),
    });
    expect((await store.loadContextState("conversation-1"))?.usage).toMatchObject({
      usedTokens: estimateContextRequestTokens(rebuilt),
      source: "compaction",
    });
  });

  it("clears every clearable tool result in the compaction tail without protecting recent ones", async () => {
    const store = await preparedStore();
    const rebuilt = {
      system: "",
      messages: Array.from({ length: 6 }, (_, index) =>
        toolResult("r".repeat(400), `call-${index}`),
      ),
    };

    const result = await preparation(store, {
      budget: CLEAR_TAIL_BUDGET,
    }).compactNow({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "", messages: [] },
      rebuild: async () => rebuilt,
    });

    expect(result.status).toBe("compacted");
    const state = await store.loadContextState("conversation-1");
    expect(state?.pruning).toMatchObject({ prunedCount: 6 });
    expect(state?.prunedToolCallIds).toEqual(
      Array.from({ length: 6 }, (_, index) => `call-${index}`),
    );
  });

  it("does not trim to the post-compaction target when manual summary generation fails", async () => {
    const store = await preparedStore();
    const generate = vi.fn(async () => {
      throw new Error("模型不支持 temperature");
    });
    const modelRequest = {
      system: "x".repeat(6_000),
      messages: [
        { role: "user" as const, content: "旧上下文" },
        { role: "assistant" as const, content: "a".repeat(2_400) },
        { role: "user" as const, content: "当前问题" },
      ],
    };
    const originalEstimate = estimateContextRequestTokens(modelRequest);

    const result = await preparation(store, { budget: REBUILD_BUDGET, generate }).compactNow({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest,
      rebuild: async () => {
        throw new Error("摘要失败时不应重建");
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      errorText: "模型不支持 temperature",
      usage: { usedTokens: originalEstimate },
    });
    expect((await store.loadContextState("conversation-1"))?.checkpoints).toHaveLength(0);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("passes one-shot manual instructions into the summary prompt", async () => {
    const store = await preparedStore();
    const generate = vi.fn<ContextSummaryGenerator>(async () => "偏重迁移决定的摘要");

    const result = await preparation(store, { generate }).compactNow({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "small", messages: [] },
      rebuild: async () => ({ system: "small", messages: [] }),
      compactionInstructions: "  重点保留数据库迁移决定  ",
    });

    expect(result.status).toBe("compacted");
    const prompt = generate.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).toContain("重点保留数据库迁移决定");
    expect(prompt).not.toContain("  重点保留数据库迁移决定  ");
    expect((await store.loadContextState("conversation-1"))?.checkpoints.at(-1)?.instructions).toBe(
      "重点保留数据库迁移决定",
    );
  });

  it("fails closed before calling the model when manual instructions are too long", async () => {
    const store = await preparedStore();
    const generate = vi.fn(async () => "不应调用");

    await expect(
      preparation(store, { generate }).compactNow({
        conversationId: "conversation-1",
        getAccessToken: async () => "token",
        modelRequest: { system: "small", messages: [] },
        rebuild: async () => ({ system: "small", messages: [] }),
        compactionInstructions: "x".repeat(MANUAL_COMPACTION_INSTRUCTIONS_MAX_CHARS + 1),
      }),
    ).rejects.toThrow(`压缩指令不能超过 ${MANUAL_COMPACTION_INSTRUCTIONS_MAX_CHARS} 个字符`);
    expect(generate).not.toHaveBeenCalled();
    expect((await store.loadContextState("conversation-1"))?.compaction).toBeUndefined();
  });

  it("returns the rebuilt request only when provider recovery actually compacts", async () => {
    const store = await preparedStore();
    const rebuilt = { system: "small", messages: [] };

    const result = await preparation(store).recoverRequest({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "small", messages: [] },
      rebuild: async () => rebuilt,
    });

    expect(result).toEqual(rebuilt);
    expect((await store.loadContextState("conversation-1"))?.compaction).toMatchObject({
      state: "succeeded",
      trigger: "auto",
    });
  });

  it("declines provider recovery when the automatic failure breaker is open", async () => {
    const store = await preparedStore();
    const retryAt = "2026-11-14T10:05:00.000Z";
    await store.saveContextState("conversation-1", {
      checkpoints: [],
      compactionFailureCount: 3,
      compactionRetryAt: retryAt,
    });
    const generate = vi.fn(async () => "不应调用");

    const result = await preparation(store, {
      generate,
      now: () => new Date("2026-11-14T10:00:00.000Z"),
    }).recoverRequest({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "small", messages: [] },
      rebuild: async () => ({ system: "small", messages: [] }),
    });

    expect(result).toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
  });

  it("declines provider recovery and counts the failure when compaction fails", async () => {
    const store = await preparedStore();
    const generate = vi.fn(async () => {
      throw new Error("摘要失败");
    });

    const result = await preparation(store, { generate }).recoverRequest({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      modelRequest: { system: "small", messages: [] },
      rebuild: async () => ({ system: "small", messages: [] }),
    });

    expect(result).toBeUndefined();
    expect(await store.loadContextState("conversation-1")).toMatchObject({
      compactionFailureCount: 1,
      compaction: { state: "failed", trigger: "auto" },
    });
  });

  it("compacts a single pending user message on demand", async () => {
    const store = new MemoryConversationStore();
    await store.create("conversation-1");
    await store.appendUserMessage("conversation-1", message("m1", "只有一条"));
    const generate = vi.fn(async () => "单条摘要");
    const rebuild = vi.fn(async () => ({ system: "small", messages: [] }));

    await expect(
      preparation(store, { generate }).compactNow({
        conversationId: "conversation-1",
        getAccessToken: async () => "token",
        modelRequest: { system: "small", messages: [] },
        rebuild,
      }),
    ).resolves.toEqual({ status: "compacted", usage: expect.any(Object) });

    expect(generate).toHaveBeenCalledOnce();
    expect(rebuild).toHaveBeenCalledOnce();
    expect((await store.loadContextState("conversation-1"))?.checkpoints.at(-1)).toMatchObject({
      throughMessageId: "m1",
      retainedUserMessages: [{ id: "m1" }],
    });
  });

  it("skips manual compaction when the checkpoint already covers the transcript", async () => {
    const store = new MemoryConversationStore();
    await store.create("conversation-1");
    await store.appendUserMessage("conversation-1", message("m1", "已压缩"));
    await store.saveContextState("conversation-1", {
      checkpoints: [checkpoint("m1")],
    });
    const generate = vi.fn(async () => "不应调用");

    await expect(
      preparation(store, { generate }).compactNow({
        conversationId: "conversation-1",
        getAccessToken: async () => "token",
        modelRequest: { system: "small", messages: [] },
        rebuild: async () => {
          throw new Error("不应重建");
        },
      }),
    ).resolves.toEqual({ status: "skipped", reason: "insufficient-messages" });

    expect(generate).not.toHaveBeenCalled();
  });

  it("bypasses the automatic failure breaker without counting a manual failure", async () => {
    const store = await preparedStore();
    const retryAt = "2026-11-14T10:05:00.000Z";
    await store.saveContextState("conversation-1", {
      checkpoints: [],
      compactionFailureCount: 3,
      compactionRetryAt: retryAt,
    });
    const generate = vi.fn(async () => {
      throw new Error("摘要失败");
    });

    await expect(
      preparation(store, {
        generate,
        now: () => new Date("2026-11-14T10:00:00.000Z"),
      }).compactNow({
        conversationId: "conversation-1",
        getAccessToken: async () => "token",
        modelRequest: { system: "small", messages: [] },
        rebuild: async () => ({ system: "small", messages: [] }),
      }),
    ).resolves.toEqual({ status: "failed", errorText: "摘要失败", usage: expect.any(Object) });

    expect(generate).toHaveBeenCalledOnce();
    expect(await store.loadContextState("conversation-1")).toMatchObject({
      compactionFailureCount: 3,
      compactionRetryAt: retryAt,
      compaction: { state: "failed", trigger: "manual" },
    });
  });

  it("reports an aborted manual compaction without counting a failure", async () => {
    const store = await preparedStore();
    const controller = new AbortController();
    const generate = vi.fn(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });

    await expect(
      preparation(store, { generate }).compactNow({
        conversationId: "conversation-1",
        getAccessToken: async () => "token",
        modelRequest: { system: "small", messages: [] },
        rebuild: async () => ({ system: "small", messages: [] }),
        signal: controller.signal,
      }),
    ).resolves.toEqual({ status: "aborted" });

    expect(await store.loadContextState("conversation-1")).toMatchObject({
      compaction: { state: "aborted", trigger: "manual" },
    });
    expect(
      (await store.loadContextState("conversation-1"))?.compactionFailureCount,
    ).toBeUndefined();
  });
});

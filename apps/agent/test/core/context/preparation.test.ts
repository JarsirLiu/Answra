import type { ConversationMessage } from "@answra/shared";
import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  type ContextBudgetPolicy,
  ContextLimitExceededError,
} from "../../../src/core/context/budget";
import { ContextCompactor } from "../../../src/core/context/compaction/compactor";
import type { CompactionProfile } from "../../../src/core/context/compaction/profile";
import { ContextPreparation } from "../../../src/core/context/preparation";
import type { ToolResultPruningPolicy } from "../../../src/core/context/pruning/policy";
import { PRUNED_TOOL_RESULT_TEXT } from "../../../src/core/context/pruning/prune";
import { estimateContextRequestTokens } from "../../../src/core/context/tokenEstimate";
import { READ_TOOL_NAME } from "../../../src/core/tool/toolNames";
import { MemoryConversationStore } from "../../../src/core/transcript/memoryStore";

const PROFILE: CompactionProfile = {
  retainRecentMessages: 1,
  minimumMessagesToSummarize: 1,
};

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
    profile?: CompactionProfile;
    generate?: () => Promise<string>;
    budget?: ContextBudgetPolicy;
    contextWindow?: () => number | undefined;
    toolResultPruning?: ToolResultPruningPolicy;
  } = {},
): ContextPreparation {
  const compactor = new ContextCompactor({
    store,
    profile: options.profile ?? PROFILE,
    generate: options.generate ?? (async () => "压缩后的摘要"),
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
  });

  it("trims the oldest complete turn when compaction cannot reduce the request", async () => {
    const store = await preparedStore();
    const generate = vi.fn(async () => "不应调用");
    const messages: ModelMessage[] = [
      { role: "user", content: "o".repeat(400) },
      { role: "assistant", content: "a".repeat(400) },
      { role: "user", content: "current" },
    ];

    const result = await preparation(store, {
      profile: { retainRecentMessages: 2, minimumMessagesToSummarize: 1 },
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
    const generate = vi.fn(async () => "不应调用");

    await expect(
      preparation(store, {
        profile: { retainRecentMessages: 2, minimumMessagesToSummarize: 1 },
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

  it("persists the final request usage and applied pruning for snapshots", async () => {
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
      usedTokens: estimateContextRequestTokens(result),
      inputLimit: 800,
      compactAt: 750,
      pruneAt: 500,
      pruneTarget: 100,
    });
    expect(state?.pruning).toMatchObject({ trigger: "auto", prunedCount: expect.any(Number) });
    expect(state?.pruning?.savedTokens).toBeGreaterThan(0);
    expect(snapshot.contextUsage).toEqual(state?.usage);
    expect(snapshot.contextPruning).toEqual(state?.pruning);
    expect(onStatus).toHaveBeenCalledOnce();
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
});

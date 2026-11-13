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
    toolResultPruning?: ToolResultPruningPolicy;
  } = {},
): ContextPreparation {
  const compactor = new ContextCompactor({
    store,
    profile: options.profile ?? PROFILE,
    generate: options.generate ?? (async () => "压缩后的摘要"),
  });
  return new ContextPreparation({
    compactor,
    budget: options.budget ?? SMALL_BUDGET,
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
});

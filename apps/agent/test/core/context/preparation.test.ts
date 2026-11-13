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
  } = {},
): ContextPreparation {
  const compactor = new ContextCompactor({
    store,
    profile: options.profile ?? PROFILE,
    generate: options.generate ?? (async () => "压缩后的摘要"),
  });
  return new ContextPreparation({ compactor, budget: SMALL_BUDGET });
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
});

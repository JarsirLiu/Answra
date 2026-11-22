import type { ConversationMessage, ConversationSnapshot } from "@answra/shared";
import { describe, expect, it, vi } from "vitest";
import type { ContextCompactionFact } from "../../../src/core/context/compaction/compactor";
import { ContextCompactor } from "../../../src/core/context/compaction/compactor";
import { MemoryConversationStore } from "../../../src/core/transcript/memoryStore";

const TRIGGER_TOKENS = 750;

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

describe("ContextCompactor", () => {
  it("uses the prepared final-request token estimate and publishes lifecycle snapshots", async () => {
    const store = await preparedStore();
    await store.saveContextState("conversation-1", {
      checkpoints: [],
      usageAnchor: {
        inputTokens: 900,
        estimatedTokens: 600,
        createdAt: "2026-11-14T10:00:00.000Z",
      },
    });
    const snapshots: ConversationSnapshot[] = [];
    const compactor = new ContextCompactor({
      store,
      generate: async () => "压缩后的摘要",
      onSnapshot: (snapshot) => {
        snapshots.push(snapshot);
      },
      now: () => new Date("2026-11-13T10:00:00.000Z"),
    });

    const compacted = await compactor.prepare({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      triggerTokens: TRIGGER_TOKENS,
      finalRequestTokens: TRIGGER_TOKENS,
      prunedToolCallIds: [],
    });

    expect(compacted).toMatchObject({
      status: "compacted",
      summarizedMessages: 2,
      retainedUserMessages: 2,
    });
    expect(snapshots.map((snapshot) => snapshot.contextCompaction?.state)).toEqual([
      "started",
      "succeeded",
    ]);
    expect((await store.load("conversation-1")).contextCompaction).toMatchObject({
      state: "succeeded",
      trigger: "auto",
      summarizedMessages: 2,
      finishedAt: "2026-11-13T10:00:00.000Z",
    });
    expect((await store.loadContextState("conversation-1"))?.usageAnchor).toBeUndefined();
  });

  it("persists a checkpoint while the conversation still has an active run", async () => {
    const store = await preparedStore();
    await store.beginRun("conversation-1", "run-1", message("m3", "当前请求"));
    const compactor = new ContextCompactor({
      store,
      generate: async () => "压缩后的摘要",
    });

    const compacted = await compactor.prepare({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      triggerTokens: TRIGGER_TOKENS,
      finalRequestTokens: TRIGGER_TOKENS,
      prunedToolCallIds: [],
    });

    expect(compacted.status).toBe("compacted");
    expect((await store.load("conversation-1")).activeMessageId).toBe("run-1");
    expect((await store.loadContextState("conversation-1"))?.checkpoints.at(-1)).toMatchObject({
      summary: "压缩后的摘要",
      throughMessageId: "run-1",
      retainedUserMessages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
    });
  });

  it("records cancellation as aborted and keeps the transcript unchanged", async () => {
    const store = await preparedStore();
    const controller = new AbortController();
    const messagesBefore = (await store.load("conversation-1")).messages;
    const compactor = new ContextCompactor({
      store,
      generate: async ({ signal }) => {
        expect(signal).toBe(controller.signal);
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      },
    });

    const compacted = await compactor.prepare({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      triggerTokens: TRIGGER_TOKENS,
      finalRequestTokens: TRIGGER_TOKENS,
      prunedToolCallIds: [],
      signal: controller.signal,
    });

    expect(compacted).toEqual({ status: "aborted" });
    expect((await store.loadContextState("conversation-1"))?.checkpoints).toEqual([]);
    expect((await store.load("conversation-1")).contextCompaction).toMatchObject({
      state: "aborted",
    });
    expect((await store.load("conversation-1")).messages).toEqual(messagesBefore);
  });

  it("publishes failure without blocking the caller", async () => {
    const store = await preparedStore();
    const snapshots: ConversationSnapshot[] = [];
    const compactor = new ContextCompactor({
      store,
      generate: async () => {
        throw new Error("摘要模型不可用");
      },
      onSnapshot: (snapshot) => {
        snapshots.push(snapshot);
      },
    });

    const compacted = await compactor.prepare({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      triggerTokens: TRIGGER_TOKENS,
      finalRequestTokens: TRIGGER_TOKENS,
      prunedToolCallIds: [],
    });

    expect(compacted).toMatchObject({ status: "failed" });
    expect(snapshots.map((snapshot) => snapshot.contextCompaction?.state)).toEqual([
      "started",
      "failed",
    ]);
    expect((await store.load("conversation-1")).contextCompaction).toMatchObject({
      state: "failed",
      errorText: "摘要模型不可用",
    });
  });

  it("trips the failure breaker after three consecutive failures and allows manual bypass", async () => {
    const store = await preparedStore();
    const generate = vi.fn(async () => {
      throw new Error("摘要失败");
    });
    const compactor = new ContextCompactor({
      store,
      generate,
      now: () => new Date("2026-11-14T10:00:00.000Z"),
    });
    const prepare = () =>
      compactor.prepare({
        conversationId: "conversation-1",
        getAccessToken: async () => "token",
        triggerTokens: TRIGGER_TOKENS,
        finalRequestTokens: TRIGGER_TOKENS,
        prunedToolCallIds: [],
      });

    await expect(prepare()).resolves.toMatchObject({ status: "failed" });
    await expect(prepare()).resolves.toMatchObject({ status: "failed" });
    await expect(prepare()).resolves.toMatchObject({ status: "failed" });
    expect(generate).toHaveBeenCalledTimes(3);

    await expect(prepare()).resolves.toEqual({
      status: "skipped",
      reason: "breaker-open",
    });
    expect(generate).toHaveBeenCalledTimes(3);

    await expect(
      compactor.prepare({
        conversationId: "conversation-1",
        getAccessToken: async () => "token",
        triggerTokens: TRIGGER_TOKENS,
        finalRequestTokens: TRIGGER_TOKENS,
        prunedToolCallIds: [],
        bypassFailureBreaker: true,
      }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(generate).toHaveBeenCalledTimes(4);
  });

  it("clears the failure count after a successful compaction", async () => {
    const store = await preparedStore();
    const generate = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("失败一"))
      .mockRejectedValueOnce(new Error("失败二"))
      .mockResolvedValueOnce("成功摘要");
    const compactor = new ContextCompactor({ store, generate });
    const prepare = () =>
      compactor.prepare({
        conversationId: "conversation-1",
        getAccessToken: async () => "token",
        triggerTokens: TRIGGER_TOKENS,
        finalRequestTokens: TRIGGER_TOKENS,
        prunedToolCallIds: [],
      });

    await prepare();
    await prepare();
    await expect(prepare()).resolves.toMatchObject({ status: "compacted" });

    expect(
      (await store.loadContextState("conversation-1"))?.compactionFailureCount,
    ).toBeUndefined();
  });

  it("does not request a token when no compaction is needed", async () => {
    const store = await preparedStore();
    const getAccessToken = vi.fn(async () => "token");
    const generate = vi.fn(async () => "不应调用");
    const compactor = new ContextCompactor({
      store,
      generate,
    });

    await expect(
      compactor.prepare({
        conversationId: "conversation-1",
        getAccessToken,
        triggerTokens: TRIGGER_TOKENS,
        finalRequestTokens: TRIGGER_TOKENS - 1,
        prunedToolCallIds: [],
      }),
    ).resolves.toEqual({ status: "skipped", reason: "below-threshold" });

    expect(getAccessToken).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("reports one operation id across the compaction lifecycle", async () => {
    const store = await preparedStore();
    const facts: ContextCompactionFact[] = [];
    const compactor = new ContextCompactor({
      store,
      generate: async () => "压缩后的摘要",
      onCompaction: (fact) => {
        facts.push(fact);
      },
      now: () => new Date("2026-11-13T10:00:00.000Z"),
    });

    const compacted = await compactor.prepare({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      triggerTokens: TRIGGER_TOKENS,
      finalRequestTokens: TRIGGER_TOKENS,
      prunedToolCallIds: [],
    });

    expect(compacted).toMatchObject({ status: "compacted" });
    expect(facts.map((fact) => fact.event.type)).toEqual([
      "compaction-started",
      "compaction-finished",
    ]);
    expect(new Set(facts.map((fact) => fact.operationId)).size).toBe(1);
    expect(facts[0]?.event).toMatchObject({
      type: "compaction-started",
      trigger: "auto",
      reason: "threshold",
    });
    expect(facts[1]?.event).toMatchObject({
      type: "compaction-finished",
      summarizedMessages: 2,
      summary: "压缩后的摘要",
    });
    expect(facts[0]?.conversationId).toBe("conversation-1");
  });

  it("reuses the Scheduler operation id for manual compaction", async () => {
    const store = await preparedStore();
    const facts: ContextCompactionFact[] = [];
    const compactor = new ContextCompactor({
      store,
      generate: async () => "手动摘要",
      onCompaction: (fact) => {
        facts.push(fact);
      },
    });

    await compactor.prepare({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      trigger: "manual",
      operationId: "operation-manual",
      force: true,
      bypassFailureBreaker: true,
      triggerTokens: TRIGGER_TOKENS,
      finalRequestTokens: 0,
      prunedToolCallIds: [],
    });

    expect(facts.map((fact) => fact.operationId)).toEqual(["operation-manual", "operation-manual"]);
    expect(facts[0]?.event).toMatchObject({
      type: "compaction-started",
      trigger: "manual",
      reason: "manual",
    });
  });

  it("reports cancellation as aborted and failure as failed", async () => {
    const abortedStore = await preparedStore();
    const abortedFacts: ContextCompactionFact[] = [];
    const controller = new AbortController();
    const aborted = new ContextCompactor({
      store: abortedStore,
      generate: async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      },
      onCompaction: (fact) => {
        abortedFacts.push(fact);
      },
    });

    await expect(
      aborted.prepare({
        conversationId: "conversation-1",
        getAccessToken: async () => "token",
        triggerTokens: TRIGGER_TOKENS,
        finalRequestTokens: TRIGGER_TOKENS,
        prunedToolCallIds: [],
        signal: controller.signal,
      }),
    ).resolves.toEqual({ status: "aborted" });
    expect(abortedFacts.map((fact) => fact.event.type)).toEqual([
      "compaction-started",
      "compaction-aborted",
    ]);

    const failedStore = await preparedStore();
    const failedFacts: ContextCompactionFact[] = [];
    const failed = new ContextCompactor({
      store: failedStore,
      generate: async () => {
        throw new Error("摘要模型不可用");
      },
      onCompaction: (fact) => {
        failedFacts.push(fact);
      },
    });

    await failed.prepare({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      triggerTokens: TRIGGER_TOKENS,
      finalRequestTokens: TRIGGER_TOKENS,
      prunedToolCallIds: [],
    });
    expect(failedFacts[1]?.event).toMatchObject({
      type: "compaction-failed",
      errorText: "摘要模型不可用",
    });
  });

  it("does not report a skipped compaction", async () => {
    const store = await preparedStore();
    const facts: ContextCompactionFact[] = [];
    const compactor = new ContextCompactor({
      store,
      generate: async () => "不应调用",
      onCompaction: (fact) => {
        facts.push(fact);
      },
    });

    await compactor.prepare({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
      triggerTokens: TRIGGER_TOKENS,
      finalRequestTokens: TRIGGER_TOKENS - 1,
      prunedToolCallIds: [],
    });

    expect(facts).toEqual([]);
  });

  it("keeps compacting when the journal observer rejects", async () => {
    const store = await preparedStore();
    const compactor = new ContextCompactor({
      store,
      generate: async () => "压缩后的摘要",
      onCompaction: async () => {
        throw new Error("journal 不可写");
      },
    });

    await expect(
      compactor.prepare({
        conversationId: "conversation-1",
        getAccessToken: async () => "token",
        triggerTokens: TRIGGER_TOKENS,
        finalRequestTokens: TRIGGER_TOKENS,
        prunedToolCallIds: [],
      }),
    ).resolves.toMatchObject({ status: "compacted" });
  });
});

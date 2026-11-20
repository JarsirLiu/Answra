import type { ConversationMessage, ConversationSnapshot } from "@answra/shared";
import { describe, expect, it, vi } from "vitest";
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
      contextTokens: TRIGGER_TOKENS,
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
      contextTokens: TRIGGER_TOKENS,
    });

    expect(compacted.status).toBe("compacted");
    expect((await store.load("conversation-1")).activeRunId).toBe("run-1");
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
      contextTokens: TRIGGER_TOKENS,
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
      contextTokens: TRIGGER_TOKENS,
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
        contextTokens: TRIGGER_TOKENS,
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
        contextTokens: TRIGGER_TOKENS,
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
        contextTokens: TRIGGER_TOKENS,
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
      }),
    ).resolves.toEqual({ status: "skipped", reason: "below-threshold" });

    expect(getAccessToken).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});

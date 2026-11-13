import type { ConversationMessage, ConversationSnapshot } from "@answra/shared";
import { describe, expect, it, vi } from "vitest";
import { ContextCompactor } from "../../../src/core/context/compaction/compactor";
import type { CompactionProfile } from "../../../src/core/context/compaction/profile";
import { MemoryConversationStore } from "../../../src/core/transcript/memoryStore";

const PROFILE: CompactionProfile = {
  retainRecentMessages: 1,
  minimumMessagesToSummarize: 1,
  triggerTokens: 1,
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

describe("ContextCompactor", () => {
  it("publishes started and succeeded snapshots", async () => {
    const store = await preparedStore();
    const snapshots: ConversationSnapshot[] = [];
    const compactor = new ContextCompactor({
      store,
      profile: PROFILE,
      generate: async () => "压缩后的摘要",
      onSnapshot: (snapshot) => {
        snapshots.push(snapshot);
      },
      now: () => new Date("2026-11-13T10:00:00.000Z"),
    });

    const compacted = await compactor.prepare({
      conversationId: "conversation-1",
      getAccessToken: async () => "token",
    });

    expect(compacted).toBe(true);
    expect(snapshots.map((snapshot) => snapshot.contextCompaction?.state)).toEqual([
      "started",
      "succeeded",
    ]);
    expect((await store.load("conversation-1")).contextCompaction).toMatchObject({
      state: "succeeded",
      trigger: "auto",
      summarizedMessages: 1,
      finishedAt: "2026-11-13T10:00:00.000Z",
    });
  });

  it("publishes failure without blocking the caller", async () => {
    const store = await preparedStore();
    const snapshots: ConversationSnapshot[] = [];
    const compactor = new ContextCompactor({
      store,
      profile: PROFILE,
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
    });

    expect(compacted).toBe(false);
    expect(snapshots.map((snapshot) => snapshot.contextCompaction?.state)).toEqual([
      "started",
      "failed",
    ]);
    expect((await store.load("conversation-1")).contextCompaction).toMatchObject({
      state: "failed",
      errorText: "摘要模型不可用",
    });
  });

  it("does not request a token when no compaction is needed", async () => {
    const store = await preparedStore();
    const getAccessToken = vi.fn(async () => "token");
    const generate = vi.fn(async () => "不应调用");
    const compactor = new ContextCompactor({
      store,
      profile: { ...PROFILE, triggerTokens: 100_000 },
      generate,
    });

    await expect(
      compactor.prepare({ conversationId: "conversation-1", getAccessToken }),
    ).resolves.toBe(false);

    expect(getAccessToken).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});

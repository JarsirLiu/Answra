import type { ConversationMessage } from "@answra/shared";
import { describe, expect, it } from "vitest";
import { planCompaction } from "../../../src/core/context/compaction/plan";
import type { CompactionProfile } from "../../../src/core/context/compaction/profile";
import type { ContextCheckpoint } from "../../../src/core/transcript/contextState";

const PROFILE: CompactionProfile = {
  retainRecentMessages: 2,
  minimumMessagesToSummarize: 2,
};

const TRIGGER_TOKENS = 10;

function message(
  id: string,
  text: string,
  role: "user" | "assistant" = "user",
): ConversationMessage {
  return {
    id,
    role,
    text,
    images: [],
    status: "complete",
  };
}

function checkpoint(throughMessageId: string, summary = "旧摘要"): ContextCheckpoint {
  return {
    summary,
    throughMessageId,
    createdAt: "2026-11-13T00:00:00.000Z",
    messageCount: 2,
  };
}

describe("context compaction plan", () => {
  it("keeps recent messages untouched when the context is below budget", () => {
    expect(
      planCompaction({
        messages: [message("m1", "短")],
        checkpoint: undefined,
        profile: PROFILE,
        triggerTokens: 100,
      }),
    ).toBeUndefined();
  });

  it("skips the budget gate only when compaction is forced", () => {
    const messages = [
      message("m1", "旧消息"),
      message("m2", "旧回复", "assistant"),
      message("m3", "保留消息一"),
      message("m4", "保留消息二", "assistant"),
    ];

    expect(
      planCompaction({
        messages,
        checkpoint: undefined,
        profile: PROFILE,
        triggerTokens: 100,
      }),
    ).toBeUndefined();
    expect(
      planCompaction({
        messages,
        checkpoint: undefined,
        profile: PROFILE,
        triggerTokens: 100,
        force: true,
      })?.messagesToSummarize.map((item) => item.id),
    ).toEqual(["m1", "m2"]);
  });

  it("summarizes the oldest messages and retains the configured tail", () => {
    const messages = [
      message("m1", "第一轮需求"),
      message("m2", "第一轮回答", "assistant"),
      message("m3", "第二轮需求"),
      message("m4", "第二轮回答", "assistant"),
      message("m5", "第三轮需求"),
      message("m6", "第三轮回答", "assistant"),
    ];

    const plan = planCompaction({
      messages,
      checkpoint: undefined,
      profile: PROFILE,
      triggerTokens: TRIGGER_TOKENS,
    });

    expect(plan?.messagesToSummarize.map((item) => item.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(plan?.retainedMessages.map((item) => item.id)).toEqual(["m5", "m6"]);
  });

  it("does not re-summarize messages already covered by the latest checkpoint", () => {
    const messages = [
      message("m1", "已压缩"),
      message("m2", "已压缩回答", "assistant"),
      message("m3", "新需求"),
      message("m4", "新回答", "assistant"),
      message("m5", "最新需求"),
      message("m6", "最新回答", "assistant"),
    ];

    const plan = planCompaction({
      messages,
      checkpoint: checkpoint("m2"),
      profile: PROFILE,
      triggerTokens: 1,
    });

    expect(plan?.messagesToSummarize.map((item) => item.id)).toEqual(["m3", "m4"]);
    expect(plan?.retainedMessages.map((item) => item.id)).toEqual(["m5", "m6"]);
  });

  it("refuses to compact when the checkpoint no longer exists", () => {
    expect(
      planCompaction({
        messages: [message("m1", "新消息")],
        checkpoint: checkpoint("missing"),
        profile: PROFILE,
        triggerTokens: 1,
      }),
    ).toBeUndefined();
  });
});

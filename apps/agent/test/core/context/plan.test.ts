import type { ConversationMessage } from "@answra/shared";
import { describe, expect, it } from "vitest";
import {
  type CompactionRetention,
  planCompaction,
} from "../../../src/core/context/compaction/plan";
import type { CompactionProfile } from "../../../src/core/context/compaction/profile";
import type { ContextCheckpoint } from "../../../src/core/transcript/contextCheckpoint";

const PROFILE: CompactionProfile = {
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

function plan(
  messages: ConversationMessage[],
  retention: CompactionRetention,
  options: {
    checkpoint?: ContextCheckpoint;
    triggerTokens?: number;
    force?: boolean;
  } = {},
) {
  return planCompaction({
    messages,
    checkpoint: options.checkpoint,
    profile: PROFILE,
    retention,
    triggerTokens: options.triggerTokens ?? TRIGGER_TOKENS,
    ...(options.force ? { force: true } : {}),
  });
}

describe("context compaction plan", () => {
  it("keeps recent messages untouched when the context is below budget", () => {
    expect(
      plan([message("m1", "短")], "current-user-turn", { triggerTokens: 100 }),
    ).toBeUndefined();
  });

  it("skips the budget gate only when compaction is forced", () => {
    const messages = [
      message("m1", "旧消息"),
      message("m2", "旧回复", "assistant"),
      message("m3", "保留消息一"),
      message("m4", "保留消息二", "assistant"),
    ];

    expect(plan(messages, "current-user-turn", { triggerTokens: 100 })).toBeUndefined();
    expect(
      plan(messages, "current-user-turn", {
        triggerTokens: 100,
        force: true,
      })?.messagesToSummarize.map((item) => item.id),
    ).toEqual(["m1", "m2"]);
  });

  it("summarizes everything before the last user message and retains the current turn", () => {
    const messages = [
      message("m1", "第一轮需求"),
      message("m2", "第一轮回答", "assistant"),
      message("m3", "第二轮需求"),
      message("m4", "第二轮回答", "assistant"),
      message("m5", "第三轮需求"),
      message("m6", "第三轮回答", "assistant"),
    ];

    const result = plan(messages, "current-user-turn");

    expect(result?.messagesToSummarize.map((item) => item.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(result?.retainedMessages.map((item) => item.id)).toEqual(["m5", "m6"]);
  });

  it("drops the whole tail for manual compaction", () => {
    const messages = [
      message("m1", "第一轮需求"),
      message("m2", "第一轮回答", "assistant"),
      message("m3", "第二轮需求"),
      message("m4", "第二轮回答", "assistant"),
    ];

    const result = plan(messages, "none");

    expect(result?.messagesToSummarize.map((item) => item.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(result?.retainedMessages).toEqual([]);
  });

  it("summarizes all messages when there is no user message to retain", () => {
    const messages = [
      message("m1", "内部步骤一", "assistant"),
      message("m2", "内部步骤二", "assistant"),
    ];

    const result = plan(messages, "current-user-turn");

    expect(result?.messagesToSummarize.map((item) => item.id)).toEqual(["m1", "m2"]);
    expect(result?.retainedMessages).toEqual([]);
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

    const result = plan(messages, "current-user-turn", {
      checkpoint: checkpoint("m2"),
      triggerTokens: 1,
    });

    expect(result?.messagesToSummarize.map((item) => item.id)).toEqual(["m3", "m4"]);
    expect(result?.retainedMessages.map((item) => item.id)).toEqual(["m5", "m6"]);
  });

  it("refuses to compact when the checkpoint no longer exists", () => {
    expect(
      plan([message("m1", "新消息")], "current-user-turn", {
        checkpoint: checkpoint("missing"),
        triggerTokens: 1,
      }),
    ).toBeUndefined();
  });

  it("refuses to compact when there are not enough messages before the current turn", () => {
    expect(plan([message("m1", "当前需求")], "current-user-turn", { force: true })).toBeUndefined();
  });
});

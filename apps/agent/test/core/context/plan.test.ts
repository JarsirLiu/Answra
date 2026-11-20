import type { ConversationMessage } from "@answra/shared";
import { describe, expect, it } from "vitest";
import {
  decideCompaction,
  planCompaction,
  RETAINED_USER_MESSAGE_TOKEN_BUDGET,
} from "../../../src/core/context/compaction/plan";
import type { ContextCheckpoint } from "../../../src/core/transcript/contextCheckpoint";

const TRIGGER_TOKENS = 10;

function message(
  id: string,
  text: string,
  role: "user" | "assistant" = "user",
  images: ConversationMessage["images"] = [],
): ConversationMessage {
  return {
    id,
    role,
    text,
    images,
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
  options: {
    checkpoint?: ContextCheckpoint;
    triggerTokens?: number;
    force?: boolean;
  } = {},
) {
  return planCompaction({
    messages,
    checkpoint: options.checkpoint,
    triggerTokens: options.triggerTokens ?? TRIGGER_TOKENS,
    ...(options.force ? { force: true } : {}),
  });
}

describe("context compaction plan", () => {
  it("keeps messages untouched when the context is below budget", () => {
    expect(plan([message("m1", "短")], { triggerTokens: 100 })).toBeUndefined();
  });

  it("skips the budget gate only when compaction is forced", () => {
    const messages = [message("m1", "当前需求", "user")];

    expect(plan(messages, { triggerTokens: 100 })).toBeUndefined();
    expect(plan(messages, { triggerTokens: 100, force: true })?.messagesToSummarize).toEqual(
      messages,
    );
  });

  it("summarizes the current user turn and the whole tool loop", () => {
    const messages = [
      message("m1", "修复这个 bug"),
      message("m2", "", "assistant"),
      message("m3", "", "assistant"),
      message("m4", "", "assistant"),
    ];

    const result = plan(messages, { triggerTokens: 1 });

    expect(result?.messagesToSummarize.map((item) => item.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(result?.retainedUserMessages.map((item) => item.id)).toEqual(["m1"]);
  });

  it("retains recent user messages across an older checkpoint", () => {
    const messages = [
      message("m1", "原始任务"),
      message("m2", "第一次回答", "assistant"),
      message("m3", "工具步骤一", "assistant"),
      message("m4", "工具步骤二", "assistant"),
    ];

    const result = plan(messages, {
      checkpoint: checkpoint("m2"),
      triggerTokens: 1,
    });

    expect(result?.messagesToSummarize.map((item) => item.id)).toEqual(["m3", "m4"]);
    expect(result?.retainedUserMessages.map((item) => item.id)).toEqual(["m1"]);
  });

  it("does not re-summarize messages already covered by the latest checkpoint", () => {
    const messages = [
      message("m1", "已压缩用户"),
      message("m2", "已压缩回答", "assistant"),
      message("m3", "新需求"),
      message("m4", "新回答", "assistant"),
      message("m5", "最新需求"),
      message("m6", "最新回答", "assistant"),
    ];

    const result = plan(messages, {
      checkpoint: checkpoint("m2"),
      triggerTokens: 1,
    });

    expect(result?.messagesToSummarize.map((item) => item.id)).toEqual(["m3", "m4", "m5", "m6"]);
    expect(result?.retainedUserMessages.map((item) => item.id)).toEqual(["m1", "m3", "m5"]);
  });

  it("keeps only user messages in the retained set", () => {
    const messages = [
      message("m1", "需求"),
      message("m2", "回答", "assistant"),
      message("m3", "补充需求"),
    ];

    const result = plan(messages, { triggerTokens: 1 });

    expect(result?.retainedUserMessages.map((item) => item.id)).toEqual(["m1", "m3"]);
    expect(result?.retainedUserMessages.every((item) => item.role === "user")).toBe(true);
  });

  it("keeps images when the retained user message fits the budget", () => {
    const image = { name: "screen.png", dataUrl: "data:image/png;base64,AAAA" };
    const messages = [message("m1", "看图", "user", [image]), message("m2", "回答", "assistant")];

    const result = plan(messages);

    expect(result?.retainedUserMessages[0]?.images).toEqual([image]);
  });

  it("truncates the newest user message and drops older ones when the retention budget is exhausted", () => {
    const messages = [
      message("m1", "旧任务"),
      message("m2", "x".repeat(RETAINED_USER_MESSAGE_TOKEN_BUDGET * 4 + 4)),
    ];

    const result = plan(messages);

    expect(result?.retainedUserMessages).toHaveLength(1);
    expect(result?.retainedUserMessages[0]?.id).toBe("m2");
    expect(result?.retainedUserMessages[0]?.text).toContain("[用户消息因压缩预算截断]");
    expect(result?.retainedUserMessages[0]?.images).toEqual([]);
  });

  it("refuses to compact when the checkpoint no longer exists", () => {
    expect(
      plan([message("m1", "新消息")], {
        checkpoint: checkpoint("missing"),
        triggerTokens: 1,
      }),
    ).toBeUndefined();
  });

  it("skips with insufficient-messages when there is nothing after the checkpoint", () => {
    const messages = [message("m1", "已压缩")];

    expect(
      decideCompaction({
        messages,
        checkpoint: checkpoint("m1"),
        triggerTokens: TRIGGER_TOKENS,
        force: true,
      }),
    ).toEqual({ status: "skip", reason: "insufficient-messages" });
  });

  it("allows manual compaction with a single pending user message", () => {
    const result = plan([message("m1", "当前需求")], { force: true });

    expect(result?.messagesToSummarize.map((item) => item.id)).toEqual(["m1"]);
    expect(result?.retainedUserMessages.map((item) => item.id)).toEqual(["m1"]);
  });
});

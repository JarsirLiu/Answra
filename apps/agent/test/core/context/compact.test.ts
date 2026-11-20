import type { ConversationMessage } from "@answra/shared";
import { describe, expect, it, vi } from "vitest";
import {
  compactContext,
  type SummaryGeneratorInput,
} from "../../../src/core/context/compaction/compact";
import type { CompactionProfile } from "../../../src/core/context/compaction/profile";
import { CONTEXT_SUMMARY_PROMPT } from "../../../src/core/context/compaction/prompt";

const PROFILE: CompactionProfile = {
  minimumMessagesToSummarize: 1,
};

const TRIGGER_TOKENS = 1;

function message(
  id: string,
  text: string,
  role: "user" | "assistant" = "user",
): ConversationMessage {
  return { id, role, text, images: [], status: "complete" };
}

describe("context compaction", () => {
  it("uses the single universal prompt and records the summarized boundary", async () => {
    const generate = vi.fn<(input: SummaryGeneratorInput) => Promise<string>>(
      async () => "## 当前目标\n继续实现压缩",
    );

    const result = await compactContext({
      messages: [message("m1", "旧需求"), message("m2", "保留需求")],
      state: undefined,
      profile: PROFILE,
      retention: "current-user-turn",
      triggerTokens: TRIGGER_TOKENS,
      generate,
      now: () => new Date("2026-11-13T10:00:00.000Z"),
    });

    expect(generate).toHaveBeenCalledTimes(1);
    const prompt = generate.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).toContain(CONTEXT_SUMMARY_PROMPT);
    expect(prompt).toContain("旧需求");
    expect(prompt).not.toContain("保留需求");
    expect(result.status).toBe("compacted");
    if (result.status !== "compacted") throw new Error("expected compaction");
    expect(result.summarizedMessages).toBe(1);
    expect(result.state).toEqual({
      checkpoints: [
        {
          summary: "## 当前目标\n继续实现压缩",
          throughMessageId: "m1",
          createdAt: "2026-11-13T10:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
  });

  it("summarizes the whole tail for manual compaction", async () => {
    const generate = vi.fn<(input: SummaryGeneratorInput) => Promise<string>>(
      async () => "手动压缩摘要",
    );

    const result = await compactContext({
      messages: [
        message("m1", "旧需求"),
        message("m2", "旧回答", "assistant"),
        message("m3", "最后需求"),
      ],
      state: undefined,
      profile: PROFILE,
      retention: "none",
      triggerTokens: TRIGGER_TOKENS,
      generate,
    });

    const prompt = generate.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).toContain("最后需求");
    if (result.status !== "compacted") throw new Error("expected compaction");
    expect(result.summarizedMessages).toBe(3);
    expect(result.state.checkpoints.at(-1)?.throughMessageId).toBe("m3");
  });

  it("appends one-shot manual instructions without replacing the base prompt", async () => {
    const generate = vi.fn<(input: SummaryGeneratorInput) => Promise<string>>(
      async () => "偏重迁移决定的摘要",
    );

    const result = await compactContext({
      messages: [message("m1", "旧需求"), message("m2", "保留需求")],
      state: undefined,
      profile: PROFILE,
      retention: "current-user-turn",
      triggerTokens: TRIGGER_TOKENS,
      instructions: "重点保留数据库迁移决定",
      generate,
    });

    const prompt = generate.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).toContain(CONTEXT_SUMMARY_PROMPT);
    expect(prompt).toContain("## 用户附加摘要指令");
    expect(prompt).toContain("重点保留数据库迁移决定");
    expect(prompt.indexOf("## 待压缩会话")).toBeLessThan(prompt.indexOf("## 用户附加摘要指令"));
    if (result.status !== "compacted") throw new Error("expected compaction");
    expect(result.state.checkpoints.at(-1)?.instructions).toBe("重点保留数据库迁移决定");
  });

  it("merges the previous summary into the next checkpoint", async () => {
    const generate = vi.fn<(input: SummaryGeneratorInput) => Promise<string>>(
      async () => "更新后的摘要",
    );

    const result = await compactContext({
      messages: [
        message("m1", "已压缩一"),
        message("m2", "已压缩二"),
        message("m3", "新消息"),
        message("m4", "保留消息"),
      ],
      state: {
        checkpoints: [
          {
            summary: "旧摘要正文",
            throughMessageId: "m2",
            createdAt: "2026-11-12T00:00:00.000Z",
            messageCount: 2,
          },
        ],
      },
      profile: PROFILE,
      retention: "current-user-turn",
      triggerTokens: TRIGGER_TOKENS,
      generate,
    });

    const prompt = generate.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).toContain("旧摘要正文");
    expect(prompt).toContain("新消息");
    expect(prompt).not.toContain("已压缩一");
    if (result.status !== "compacted") throw new Error("expected compaction");
    expect(result.state.checkpoints).toHaveLength(2);
    expect(result.state.checkpoints.at(-1)?.throughMessageId).toBe("m3");
    expect(result.state.checkpoints.at(-1)?.messageCount).toBe(3);
  });

  it("returns a skip reason without calling the model when no compaction is needed", async () => {
    const generate = vi.fn<(input: SummaryGeneratorInput) => Promise<string>>(
      async () => "不应调用",
    );

    const result = await compactContext({
      messages: [message("m1", "短消息")],
      state: undefined,
      profile: PROFILE,
      retention: "current-user-turn",
      triggerTokens: 100,
      generate,
    });

    expect(result).toEqual({ status: "skipped", reason: "below-threshold" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("drops the oldest message when the summary request overflows", async () => {
    const generate = vi
      .fn<(input: SummaryGeneratorInput) => Promise<string>>()
      .mockRejectedValueOnce(new Error("prompt is too long: 200000 tokens > 128000 maximum"))
      .mockResolvedValueOnce("截断后的摘要");

    const result = await compactContext({
      messages: [
        message("m1", "最早需求"),
        message("m2", "第一轮回复", "assistant"),
        message("m3", "第二轮"),
        message("m4", "第二轮回复", "assistant"),
        message("m5", "保留消息"),
      ],
      state: undefined,
      profile: PROFILE,
      retention: "current-user-turn",
      triggerTokens: TRIGGER_TOKENS,
      generate,
    });

    expect(generate).toHaveBeenCalledTimes(2);
    const retryPrompt = generate.mock.calls[1]?.[0]?.prompt ?? "";
    expect(retryPrompt).toContain("已省略最早的 1 条消息");
    expect(retryPrompt).not.toContain("最早需求");
    expect(retryPrompt).toContain("第一轮回复");
    if (result.status !== "compacted") throw new Error("expected compaction");
    expect(result.state.checkpoints.at(-1)?.summary).toBe("截断后的摘要");
  });

  it("shortens a summary that exceeds the summary token budget", async () => {
    const generate = vi
      .fn<(input: SummaryGeneratorInput) => Promise<string>>()
      .mockResolvedValueOnce("x".repeat(1_000))
      .mockResolvedValueOnce("缩短后的摘要");

    const result = await compactContext({
      messages: [message("m1", "旧需求"), message("m2", "保留需求")],
      state: undefined,
      profile: PROFILE,
      retention: "current-user-turn",
      triggerTokens: TRIGGER_TOKENS,
      summaryMaxTokens: 50,
      generate,
    });

    expect(generate).toHaveBeenCalledTimes(2);
    const shorteningPrompt = generate.mock.calls[1]?.[0]?.prompt ?? "";
    expect(shorteningPrompt).toContain("目标上限：50 token");
    if (result.status !== "compacted") throw new Error("expected compaction");
    expect(result.state.checkpoints.at(-1)?.summary).toBe("缩短后的摘要");
  });

  it("falls back to a marked truncation when shortening fails", async () => {
    const generate = vi
      .fn<(input: SummaryGeneratorInput) => Promise<string>>()
      .mockResolvedValueOnce("x".repeat(1_000))
      .mockRejectedValueOnce(new Error("shortening failed"));

    const result = await compactContext({
      messages: [message("m1", "旧需求"), message("m2", "保留需求")],
      state: undefined,
      profile: PROFILE,
      retention: "current-user-turn",
      triggerTokens: TRIGGER_TOKENS,
      summaryMaxTokens: 50,
      generate,
    });

    if (result.status !== "compacted") throw new Error("expected compaction");
    expect(result.state.checkpoints.at(-1)?.summary).toContain("[摘要因长度限制已截断]");
  });

  it("drops messages until one remains, then fails on overflow", async () => {
    const generate = vi.fn<(input: SummaryGeneratorInput) => Promise<string>>(async () => {
      throw new Error("prompt is too long");
    });

    await expect(
      compactContext({
        messages: [
          message("m1", "一"),
          message("m2", "二"),
          message("m3", "三"),
          message("m4", "四"),
          message("m5", "五"),
          message("m6", "六"),
        ],
        state: undefined,
        profile: PROFILE,
        retention: "current-user-turn",
        triggerTokens: TRIGGER_TOKENS,
        generate,
      }),
    ).rejects.toThrow("prompt is too long");

    expect(generate).toHaveBeenCalledTimes(5);
    const lastPrompt = generate.mock.calls.at(-1)?.[0]?.prompt ?? "";
    expect(lastPrompt).toContain("已省略最早的 4 条消息");
  });

  it("fails closed when the model returns an empty summary", async () => {
    await expect(
      compactContext({
        messages: [message("m1", "旧需求"), message("m2", "保留需求")],
        state: undefined,
        profile: PROFILE,
        retention: "current-user-turn",
        triggerTokens: TRIGGER_TOKENS,
        generate: async () => "   ",
      }),
    ).rejects.toThrow("上下文摘要为空");
  });
});

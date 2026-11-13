import type { ConversationMessage } from "@answra/shared";
import { describe, expect, it, vi } from "vitest";
import {
  compactContext,
  type SummaryGeneratorInput,
} from "../../../src/core/context/compaction/compact";
import type { CompactionProfile } from "../../../src/core/context/compaction/profile";
import { CONTEXT_SUMMARY_PROMPT } from "../../../src/core/context/compaction/prompt";

const PROFILE: CompactionProfile = {
  retainRecentMessages: 1,
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
      triggerTokens: TRIGGER_TOKENS,
      generate,
      now: () => new Date("2026-11-13T10:00:00.000Z"),
    });

    expect(generate).toHaveBeenCalledTimes(1);
    const prompt = generate.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).toContain(CONTEXT_SUMMARY_PROMPT);
    expect(prompt).toContain("旧需求");
    expect(prompt).not.toContain("保留需求");
    expect(result?.summarizedMessages).toBe(1);
    expect(result?.state).toEqual({
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
      triggerTokens: TRIGGER_TOKENS,
      generate,
    });

    const prompt = generate.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).toContain("旧摘要正文");
    expect(prompt).toContain("新消息");
    expect(prompt).not.toContain("已压缩一");
    expect(result?.state.checkpoints).toHaveLength(2);
    expect(result?.state.checkpoints.at(-1)?.throughMessageId).toBe("m3");
    expect(result?.state.checkpoints.at(-1)?.messageCount).toBe(3);
  });

  it("returns undefined without calling the model when no compaction is needed", async () => {
    const generate = vi.fn<(input: SummaryGeneratorInput) => Promise<string>>(
      async () => "不应调用",
    );

    const result = await compactContext({
      messages: [message("m1", "短消息")],
      state: undefined,
      profile: PROFILE,
      triggerTokens: 100,
      generate,
    });

    expect(result).toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
  });

  it("fails closed when the model returns an empty summary", async () => {
    await expect(
      compactContext({
        messages: [message("m1", "旧需求"), message("m2", "保留需求")],
        state: undefined,
        profile: PROFILE,
        triggerTokens: TRIGGER_TOKENS,
        generate: async () => "   ",
      }),
    ).rejects.toThrow("上下文摘要为空");
  });
});

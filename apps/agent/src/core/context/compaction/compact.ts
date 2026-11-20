/** 通用摘要压缩用例：读取检查点、选择旧消息、调用模型并写回新检查点。 */
import type { ConversationMessage } from "@answra/shared";
import { isContextOverflowError } from "../../model/contextOverflow";
import { type ContextCheckpoint, latestCheckpoint } from "../../transcript/contextCheckpoint";
import type { ContextState } from "../../transcript/contextState";
import { DEFAULT_SUMMARY_MAX_TOKENS } from "../budget";
import { estimateTextTokens, truncateTextToTokenBudget } from "../tokenEstimate";
import { type CompactionRetention, type CompactionSkipReason, decideCompaction } from "./plan";
import type { CompactionProfile } from "./profile";
import { buildSummaryPrompt, buildSummaryShorteningPrompt } from "./prompt";
import { dropOldestSummaryMessage, renderMessagesForSummary } from "./transcript";

export interface SummaryGeneratorInput {
  prompt: string;
  signal?: AbortSignal;
}

export type SummaryGenerator = (input: SummaryGeneratorInput) => Promise<string>;

export type CompactionAttempt =
  | {
      status: "compacted";
      state: ContextState;
      summarizedMessages: number;
    }
  | { status: "skipped"; reason: CompactionSkipReason };

export async function compactContext({
  messages,
  state,
  profile,
  retention,
  triggerTokens,
  contextTokens,
  force = false,
  instructions,
  summaryMaxTokens = DEFAULT_SUMMARY_MAX_TOKENS,
  generate,
  signal,
  now = () => new Date(),
  onStarted,
}: {
  messages: readonly ConversationMessage[];
  state: ContextState | undefined;
  profile: CompactionProfile;
  retention: CompactionRetention;
  triggerTokens: number;
  contextTokens?: number;
  /** 手动压缩跳过触发点判断。 */
  force?: boolean;
  /** 摘要输出上限；超过时先请求模型缩短，再确定性截断。 */
  summaryMaxTokens?: number;
  /** 手动压缩的一次性摘要偏好；自动与超限恢复不传。 */
  instructions?: string;
  generate: SummaryGenerator;
  signal?: AbortSignal;
  now?: () => Date;
  onStarted?: () => Promise<void>;
}): Promise<CompactionAttempt> {
  const previous = latestCheckpoint(state);
  const decision = decideCompaction({
    messages,
    checkpoint: previous,
    profile,
    retention,
    triggerTokens,
    force,
    ...(contextTokens === undefined ? {} : { contextTokens }),
  });
  if (decision.status === "skip") return { status: "skipped", reason: decision.reason };
  const plan = decision.plan;
  await onStarted?.();
  let messagesToSummarize = [...plan.messagesToSummarize];
  let omittedMessages = 0;
  let summary: string;
  for (;;) {
    const prompt = buildSummaryPrompt({
      ...(previous ? { previousSummary: previous.summary } : {}),
      transcript: renderMessagesForSummary(messagesToSummarize),
      omittedMessages,
      ...(instructions ? { instructions } : {}),
    });
    try {
      summary = (await generate({ prompt, ...(signal ? { signal } : {}) })).trim();
      break;
    } catch (error) {
      if (!isContextOverflowError(error)) throw error;
      const truncated = dropOldestSummaryMessage(messagesToSummarize);
      if (!truncated) throw error;
      omittedMessages += 1;
      messagesToSummarize = truncated;
    }
  }
  if (!summary) throw new Error("上下文摘要为空");
  summary = await enforceSummaryBudget({
    summary,
    maxTokens: summaryMaxTokens,
    generate,
    ...(signal ? { signal } : {}),
  });
  const checkpoint = createCheckpoint({
    summary,
    previous,
    summarized: plan.messagesToSummarize,
    ...(instructions ? { instructions } : {}),
    now,
  });
  // 摘要改变模型投影，旧 usage 锚点不再对应当前上下文。
  const { usageAnchor: _usageAnchor, ...base } = state ?? { checkpoints: [] };
  return {
    status: "compacted",
    state: {
      ...base,
      checkpoints: [...base.checkpoints, checkpoint],
    },
    summarizedMessages: plan.messagesToSummarize.length,
  };
}

/** 摘要超限时先让模型缩短；缩短失败再按预算硬截断并标注。 */
async function enforceSummaryBudget({
  summary,
  maxTokens,
  generate,
  signal,
}: {
  summary: string;
  maxTokens: number;
  generate: SummaryGenerator;
  signal?: AbortSignal;
}): Promise<string> {
  if (estimateTextTokens(summary) <= maxTokens) return summary;
  let candidate = summary;
  try {
    const shortened = (
      await generate({
        prompt: buildSummaryShorteningPrompt({ summary, maxTokens }),
        ...(signal ? { signal } : {}),
      })
    ).trim();
    if (shortened) {
      candidate = shortened;
      if (estimateTextTokens(shortened) <= maxTokens) return shortened;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // 缩短请求失败时退化为确定性截断，不能把超长摘要写进检查点。
    console.warn("[context-compaction] summary shortening failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const marker = "\n\n[摘要因长度限制已截断]";
  const contentBudget = Math.max(1, maxTokens - estimateTextTokens(marker));
  const truncated = truncateTextToTokenBudget(candidate, contentBudget).trimEnd();
  return `${truncated}${marker}`;
}

function createCheckpoint({
  summary,
  previous,
  summarized,
  instructions,
  now,
}: {
  summary: string;
  previous: ContextCheckpoint | undefined;
  summarized: readonly ConversationMessage[];
  instructions?: string;
  now: () => Date;
}): ContextCheckpoint {
  const last = summarized.at(-1);
  if (!last) throw new Error("没有可摘要的消息");
  return {
    summary,
    throughMessageId: last.id,
    createdAt: now().toISOString(),
    messageCount: (previous?.messageCount ?? 0) + summarized.length,
    ...(instructions ? { instructions } : {}),
  };
}

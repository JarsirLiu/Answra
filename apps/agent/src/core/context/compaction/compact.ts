/** 通用摘要压缩用例：读取检查点、选择旧消息、调用模型并写回新检查点。 */
import type { ConversationMessage } from "@answra/shared";
import { isContextOverflowError } from "../../model/contextOverflow";
import { type ContextCheckpoint, latestCheckpoint } from "../../transcript/contextCheckpoint";
import type { ContextState } from "../../transcript/contextState";
import { type CompactionSkipReason, decideCompaction } from "./plan";
import type { CompactionProfile } from "./profile";
import { buildSummaryPrompt } from "./prompt";
import { dropOldestSummaryTurn, renderMessagesForSummary } from "./transcript";

const MAX_SUMMARY_OVERFLOW_RETRIES = 3;

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
  triggerTokens,
  contextTokens,
  force = false,
  instructions,
  generate,
  signal,
  now = () => new Date(),
  onStarted,
}: {
  messages: readonly ConversationMessage[];
  state: ContextState | undefined;
  profile: CompactionProfile;
  triggerTokens: number;
  contextTokens?: number;
  /** 手动压缩跳过触发点判断。 */
  force?: boolean;
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
    triggerTokens,
    force,
    ...(contextTokens === undefined ? {} : { contextTokens }),
  });
  if (decision.status === "skip") return { status: "skipped", reason: decision.reason };
  const plan = decision.plan;
  await onStarted?.();
  let messagesToSummarize = [...plan.messagesToSummarize];
  let omittedMessages = 0;
  let overflowRetries = 0;
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
      if (overflowRetries >= MAX_SUMMARY_OVERFLOW_RETRIES) throw error;
      const truncated = dropOldestSummaryTurn(messagesToSummarize);
      if (!truncated) throw error;
      overflowRetries += 1;
      omittedMessages += messagesToSummarize.length - truncated.length;
      messagesToSummarize = truncated;
    }
  }
  if (!summary) throw new Error("上下文摘要为空");
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

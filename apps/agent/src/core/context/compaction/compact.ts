/** 通用摘要压缩用例：读取检查点、选择旧消息、调用模型并写回新检查点。 */
import type { ConversationMessage } from "@answra/shared";
import type { ContextCheckpoint, ContextState } from "../../transcript/contextState";
import { latestCheckpoint } from "../../transcript/contextState";
import { planCompaction } from "./plan";
import type { CompactionProfile } from "./profile";
import { buildSummaryPrompt } from "./prompt";
import { renderMessagesForSummary } from "./transcript";

export interface SummaryGeneratorInput {
  prompt: string;
  signal?: AbortSignal;
}

export type SummaryGenerator = (input: SummaryGeneratorInput) => Promise<string>;

export interface CompactionResult {
  state: ContextState;
  summarizedMessages: number;
}

export async function compactContext({
  messages,
  state,
  profile,
  generate,
  signal,
  now = () => new Date(),
  onStarted,
  onSummarizing,
}: {
  messages: readonly ConversationMessage[];
  state: ContextState | undefined;
  profile: CompactionProfile;
  generate: SummaryGenerator;
  signal?: AbortSignal;
  now?: () => Date;
  onStarted?: () => Promise<void>;
  onSummarizing?: () => Promise<void>;
}): Promise<CompactionResult | undefined> {
  const previous = latestCheckpoint(state);
  const plan = planCompaction({ messages, checkpoint: previous, profile });
  if (!plan) return undefined;
  await onStarted?.();
  const prompt = buildSummaryPrompt({
    ...(previous ? { previousSummary: previous.summary } : {}),
    transcript: renderMessagesForSummary(plan.messagesToSummarize),
  });
  await onSummarizing?.();
  const summary = (await generate({ prompt, ...(signal ? { signal } : {}) })).trim();
  if (!summary) throw new Error("上下文摘要为空");
  const checkpoint = createCheckpoint({
    summary,
    previous,
    summarized: plan.messagesToSummarize,
    now,
  });
  return {
    state: {
      ...(state ?? { checkpoints: [] }),
      checkpoints: [...(state?.checkpoints ?? []), checkpoint],
    },
    summarizedMessages: plan.messagesToSummarize.length,
  };
}

function createCheckpoint({
  summary,
  previous,
  summarized,
  now,
}: {
  summary: string;
  previous: ContextCheckpoint | undefined;
  summarized: readonly ConversationMessage[];
  now: () => Date;
}): ContextCheckpoint {
  const last = summarized.at(-1);
  if (!last) throw new Error("没有可摘要的消息");
  return {
    summary,
    throughMessageId: last.id,
    createdAt: now().toISOString(),
    messageCount: (previous?.messageCount ?? 0) + summarized.length,
  };
}

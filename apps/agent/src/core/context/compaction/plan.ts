/** 选择待摘要的完整区间与压缩后保留的最近用户消息；只按完整 transcript 消息切分。 */
import type { ConversationMessage } from "@answra/shared";
import {
  type ContextCheckpoint,
  messagesAfterCheckpoint,
} from "../../transcript/contextCheckpoint";
import {
  estimateMessageTokens,
  estimateTextTokens,
  truncateTextToTokenBudget,
} from "../tokenEstimate";
import type { CompactionView } from "./view";

/** 压缩后以原始消息保留的用户消息总 token 预算；与 Codex 的默认量级对齐。 */
export const RETAINED_USER_MESSAGE_TOKEN_BUDGET = 20_000;

const TRUNCATED_USER_MESSAGE_MARKER = "\n\n[用户消息因压缩预算截断]";

export interface CompactionPlan {
  /** checkpoint 之后的全部消息；摘要输入不再按角色截断。 */
  messagesToSummarize: readonly ConversationMessage[];
  /** 摘要后仍以原始消息投影的最近用户消息；assistant/tool 过程只进入摘要。 */
  retainedUserMessages: readonly ConversationMessage[];
}

export type CompactionSkipReason =
  | "below-threshold"
  | "insufficient-messages"
  | "checkpoint-invalid";

export type CompactionPlanDecision =
  | { status: "plan"; plan: CompactionPlan }
  | { status: "skip"; reason: CompactionSkipReason };

interface CompactionPlanInput {
  view: CompactionView;
  checkpoint: ContextCheckpoint | undefined;
  triggerTokens: number;
  /** 手动压缩跳过触发点判断；只要 checkpoint 之后仍有消息就允许压缩。 */
  force?: boolean;
}

/** 决定是否压缩以及跳过原因；调用方不得再自行复制这套判定。 */
export function decideCompaction(input: CompactionPlanInput): CompactionPlanDecision {
  const pending = messagesAfterCheckpoint(input.view.messages, input.checkpoint);
  if (!pending) return { status: "skip", reason: "checkpoint-invalid" };
  if (!input.force && input.view.finalRequestTokens < input.triggerTokens) {
    return { status: "skip", reason: "below-threshold" };
  }
  if (pending.length === 0) return { status: "skip", reason: "insufficient-messages" };
  return {
    status: "plan",
    plan: {
      messagesToSummarize: pending,
      // 摘要覆盖到当前最后一条消息，因此保留范围可以跨过旧 checkpoint；
      // 这样长工具循环没有新的用户消息时，原始任务仍不会从投影中消失。
      retainedUserMessages: selectRecentUserMessages(input.view.messages),
    },
  };
}

export function planCompaction(input: CompactionPlanInput): CompactionPlan | undefined {
  const decision = decideCompaction(input);
  return decision.status === "plan" ? decision.plan : undefined;
}

/** 从新到旧选择用户消息，总预算内保持原始时间顺序；超预算时截断最新一条并停止。 */
function selectRecentUserMessages(messages: readonly ConversationMessage[]): ConversationMessage[] {
  const retained: ConversationMessage[] = [];
  let remaining = RETAINED_USER_MESSAGE_TOKEN_BUDGET;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const tokens = estimateMessageTokens(message);
    if (tokens <= remaining) {
      retained.push(cloneMessage(message));
      remaining -= tokens;
      continue;
    }
    const truncated = truncateUserMessage(message, remaining);
    if (truncated) retained.push(truncated);
    break;
  }
  return retained.reverse();
}

function truncateUserMessage(
  message: ConversationMessage,
  remainingTokens: number,
): ConversationMessage | undefined {
  if (remainingTokens <= 0) return undefined;
  const contentBudget = Math.max(
    1,
    remainingTokens - estimateTextTokens(TRUNCATED_USER_MESSAGE_MARKER),
  );
  const text = truncateTextToTokenBudget(message.text, contentBudget).trimEnd();
  return {
    ...cloneMessage(message),
    text: `${text}${TRUNCATED_USER_MESSAGE_MARKER}`,
    images: [],
  };
}

function cloneMessage(message: ConversationMessage): ConversationMessage {
  return {
    ...message,
    images: message.images.map((image) => ({ ...image })),
    ...(message.parts ? { parts: message.parts.map((part) => ({ ...part })) } : {}),
  };
}

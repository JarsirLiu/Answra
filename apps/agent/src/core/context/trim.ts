/** 压缩后仍超过输入硬上限时，按完整轮次做确定性裁剪；不发送静默截断的请求。 */
import type { ModelMessage } from "ai";
import type { ContextUsageAnchor } from "../transcript/contextState";
import {
  ContextLimitExceededError,
  type ContextModelRequest,
  type ResolvedContextBudget,
} from "./budget";
import { calibrateContextTokens, estimateContextRequestTokens } from "./tokenEstimate";

export function trimContextRequest(
  request: ContextModelRequest,
  budget: ResolvedContextBudget,
  options: {
    targetTokens?: number;
    preserveLeadingMessages?: number;
    usageAnchor?: ContextUsageAnchor;
  } = {},
): ContextModelRequest {
  const targetTokens = options.targetTokens ?? budget.inputLimit;
  const preserved = Math.max(
    0,
    Math.min(options.preserveLeadingMessages ?? 0, request.messages.length),
  );
  const prefix = request.messages.slice(0, preserved);
  const estimateTokens = (messages: readonly ModelMessage[]) =>
    calibrateContextTokens(
      estimateContextRequestTokens({ ...request, messages: [...messages] }),
      options.usageAnchor,
    );
  let messages = request.messages;
  while (estimateTokens(messages) >= targetTokens) {
    const trimmed = dropOldestTurn(messages.slice(preserved));
    if (!trimmed) break;
    messages = [...prefix, ...trimmed];
  }
  const estimatedTokens = estimateTokens(messages);
  if (estimatedTokens >= budget.inputLimit) {
    throw new ContextLimitExceededError({
      estimatedTokens,
      inputLimit: budget.inputLimit,
    });
  }
  return messages === request.messages ? request : { ...request, messages };
}

/**
 * 丢弃第一轮到下一轮 user 消息之间的全部消息，包括 assistant 和 tool pair。
 * 只剩当前这一轮 user 消息时返回 undefined，避免删掉当前请求。
 */
function dropOldestTurn(messages: readonly ModelMessage[]): ModelMessage[] | undefined {
  const firstUser = messages.findIndex((message) => message.role === "user");
  if (firstUser < 0) return undefined;
  const nextUser = messages.findIndex(
    (message, index) => index > firstUser && message.role === "user",
  );
  if (nextUser < 0) return undefined;
  return messages.slice(nextUser);
}

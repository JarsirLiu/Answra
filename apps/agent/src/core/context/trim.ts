/** 压缩后仍超过输入硬上限时，按完整轮次做确定性裁剪；不发送静默截断的请求。 */
import type { ModelMessage } from "ai";
import {
  ContextLimitExceededError,
  type ContextModelRequest,
  type ResolvedContextBudget,
} from "./budget";
import { estimateContextRequestTokens } from "./tokenEstimate";

export function trimContextRequest(
  request: ContextModelRequest,
  budget: ResolvedContextBudget,
): ContextModelRequest {
  let messages = request.messages;
  while (estimateContextRequestTokens({ ...request, messages }) >= budget.inputLimit) {
    const trimmed = dropOldestTurn(messages);
    if (!trimmed) {
      throw new ContextLimitExceededError({
        estimatedTokens: estimateContextRequestTokens({ ...request, messages }),
        inputLimit: budget.inputLimit,
      });
    }
    messages = trimmed;
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

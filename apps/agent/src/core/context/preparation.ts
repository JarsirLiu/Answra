/** 最终模型请求的上下文准备编排：摘要压缩、重建与硬兜底裁剪。 */
import type { ContextCompactionTrigger } from "@answra/shared";
import type { ModelMessage } from "ai";
import {
  type ContextBudgetPolicy,
  ContextLimitExceededError,
  type ContextModelRequest,
  DEFAULT_CONTEXT_BUDGET_POLICY,
  type ResolvedContextBudget,
  resolveContextBudget,
} from "./budget";
import type { ContextCompactor } from "./compaction/compactor";
import { estimateContextRequestTokens } from "./tokenEstimate";

export interface ContextPreparationOptions {
  compactor: ContextCompactor;
  budget?: ContextBudgetPolicy;
}

export interface ContextPreparationRequest {
  conversationId: string;
  getAccessToken: () => Promise<string>;
  modelRequest: ContextModelRequest;
  rebuild: () => Promise<ContextModelRequest>;
  signal?: AbortSignal;
  trigger?: ContextCompactionTrigger;
}

/** 唯一编排入口：压缩只看最终请求，压缩后重建，仍超限时确定性裁剪。 */
export class ContextPreparation {
  private readonly compactor: ContextCompactor;
  private readonly budget: ResolvedContextBudget;

  constructor({ compactor, budget = DEFAULT_CONTEXT_BUDGET_POLICY }: ContextPreparationOptions) {
    this.compactor = compactor;
    this.budget = resolveContextBudget(budget);
  }

  async prepareRequest({
    conversationId,
    getAccessToken,
    modelRequest,
    rebuild,
    signal,
    trigger,
  }: ContextPreparationRequest): Promise<ContextModelRequest> {
    const contextTokens = estimateContextRequestTokens(modelRequest);
    const changed = await this.compactor.prepare({
      conversationId,
      getAccessToken,
      triggerTokens: this.budget.compactAt,
      contextTokens,
      ...(signal === undefined ? {} : { signal }),
      ...(trigger === undefined ? {} : { trigger }),
    });
    const current = changed ? await rebuild() : modelRequest;
    return trimContextRequest(current, this.budget);
  }
}

/**
 * 压缩后仍达到输入硬上限时，删除最旧完整轮次直到低于上限。
 * 当前请求本身过大、没有可删除的旧轮次时抛出，不发送静默截断的请求。
 */
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

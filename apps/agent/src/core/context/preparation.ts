/** 最终模型请求的上下文准备编排：usage 校准、旧工具结果清理、摘要压缩、重建与硬兜底裁剪。 */
import type { ContextCompactionTrigger } from "@answra/shared";
import type { AgentEvent } from "@answra/shared/schema";
import type { ContextUsageAnchor } from "../transcript/contextState";
import {
  type ContextBudgetPolicy,
  type ContextModelRequest,
  DEFAULT_CONTEXT_BUDGET_POLICY,
  type ResolvedContextBudget,
  resolveContextBudget,
} from "./budget";
import type { ContextCompactor } from "./compaction/compactor";
import {
  assertToolResultPruningPolicy,
  DEFAULT_TOOL_RESULT_PRUNING_POLICY,
  type ToolResultPruningPolicy,
} from "./pruning/policy";
import { pruneOldToolResults } from "./pruning/prune";
import { calibrateContextTokens, estimateContextRequestTokens } from "./tokenEstimate";
import { trimContextRequest } from "./trim";
import { type ContextStateStore, ContextUsageAnchorTracker } from "./usageAnchor";

export interface ContextPreparationOptions {
  compactor: ContextCompactor;
  contextStateStore: ContextStateStore;
  budget?: ContextBudgetPolicy;
  toolResultPruning?: ToolResultPruningPolicy;
  now?: () => Date;
}

export interface ContextPreparationRequest {
  conversationId: string;
  getAccessToken: () => Promise<string>;
  modelRequest: ContextModelRequest;
  rebuild: () => Promise<ContextModelRequest>;
  signal?: AbortSignal;
  trigger?: ContextCompactionTrigger;
}

/** 唯一编排入口：压缩只看最终请求，压缩后重建并再次清理，仍超限时确定性裁剪。 */
export class ContextPreparation {
  private readonly compactor: ContextCompactor;
  private readonly budget: ResolvedContextBudget;
  private readonly toolResultPruning: ToolResultPruningPolicy;
  private readonly usageAnchors: ContextUsageAnchorTracker;

  constructor({
    compactor,
    contextStateStore,
    budget = DEFAULT_CONTEXT_BUDGET_POLICY,
    toolResultPruning = DEFAULT_TOOL_RESULT_PRUNING_POLICY,
    now,
  }: ContextPreparationOptions) {
    assertToolResultPruningPolicy(toolResultPruning);
    this.compactor = compactor;
    this.budget = resolveContextBudget(budget);
    this.toolResultPruning = toolResultPruning;
    this.usageAnchors = new ContextUsageAnchorTracker({
      store: contextStateStore,
      ...(now ? { now } : {}),
    });
  }

  async prepareRequest({
    conversationId,
    getAccessToken,
    modelRequest,
    rebuild,
    signal,
    trigger,
  }: ContextPreparationRequest): Promise<ContextModelRequest> {
    const anchor = await this.usageAnchors.load(conversationId);
    const rawBeforeTokens = estimateContextRequestTokens(modelRequest);
    const beforeTokens = calibrateContextTokens(rawBeforeTokens, anchor);
    const initial = this.pruneIfWorthwhile(modelRequest, beforeTokens, anchor);
    let projectionChanged = initial.changed;

    const compacted = await this.compactor.prepare({
      conversationId,
      getAccessToken,
      triggerTokens: this.budget.compactAt,
      contextTokens: initial.tokens,
      ...(signal === undefined ? {} : { signal }),
      ...(trigger === undefined ? {} : { trigger }),
    });

    let final: ContextModelRequest;
    if (compacted) {
      projectionChanged = true;
      const rebuilt = await rebuild();
      const rebuiltTokens = estimateContextRequestTokens(rebuilt);
      const rebuiltPruned = this.pruneIfWorthwhile(rebuilt, rebuiltTokens, undefined);
      projectionChanged = projectionChanged || rebuiltPruned.changed;
      final = trimContextRequest(rebuiltPruned.request, this.budget);
      projectionChanged = projectionChanged || final !== rebuiltPruned.request;
    } else {
      final = trimContextRequest(initial.request, this.budget);
      projectionChanged = projectionChanged || final !== initial.request;
    }

    this.usageAnchors.stage(conversationId, {
      estimatedTokens: estimateContextRequestTokens(final),
      projectionChanged,
    });
    return final;
  }

  /** 消费 run 事件：首步 usage 成功后写入锚点，失败或投影变化后清理。 */
  async recordRunEvent(conversationId: string, event: AgentEvent): Promise<void> {
    await this.usageAnchors.recordRunEvent(conversationId, event);
  }

  /** 只有达到清理触发点且净节省达到门槛时才替换请求；重建后重复同一判断。 */
  private pruneIfWorthwhile(
    request: ContextModelRequest,
    tokens: number,
    anchor: ContextUsageAnchor | undefined,
  ): { request: ContextModelRequest; tokens: number; changed: boolean } {
    if (tokens < this.budget.pruneAt) return { request, tokens, changed: false };
    const estimateTokens = anchor
      ? (value: ContextModelRequest) =>
          calibrateContextTokens(estimateContextRequestTokens(value), anchor)
      : estimateContextRequestTokens;
    const result = pruneOldToolResults({
      request,
      targetTokens: this.budget.pruneTarget,
      policy: this.toolResultPruning,
      estimateTokens,
    });
    if (result.savedTokens < this.budget.minPruneSaving) {
      return { request, tokens, changed: false };
    }
    return {
      request: result.request,
      tokens: estimateContextRequestTokens(result.request),
      changed: true,
    };
  }
}

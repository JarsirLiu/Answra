/** 最终模型请求的上下文准备编排：usage 校准、旧工具结果清理、摘要压缩、重建与硬兜底裁剪。 */
import type { ContextCompactionTrigger, ContextPruningStatus, ContextUsage } from "@answra/shared";
import type { AgentEvent } from "@answra/shared/schema";
import type { ContextUsageAnchor } from "../transcript/contextState";
import {
  type ContextBudgetPolicy,
  type ContextModelRequest,
  contextBudgetPolicyForWindow,
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
  /** 模型端点声明的上下文窗口；优先级低于显式 budget，高于内置基准预算。 */
  contextWindow?: () => number | undefined;
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
  /** provider 已报上下文超限时强制压缩，跳过普通触发阈值。 */
  forceCompact?: boolean;
  /** 状态已写入 store 后通知宿主推�?snapshot；失败不影响本轮模型请求�?*/
  onStatus?: () => void | Promise<void>;
}

/** 唯一编排入口：压缩只看最终请求，压缩后重建并再次清理，仍超限时确定性裁剪。 */
export class ContextPreparation {
  private readonly compactor: ContextCompactor;
  private readonly fixedBudget?: ResolvedContextBudget;
  private readonly contextWindow?: () => number | undefined;
  private readonly toolResultPruning: ToolResultPruningPolicy;
  private readonly usageAnchors: ContextUsageAnchorTracker;
  private readonly store: ContextStateStore;
  private readonly now: () => Date;

  constructor({
    compactor,
    contextStateStore,
    budget,
    contextWindow,
    toolResultPruning = DEFAULT_TOOL_RESULT_PRUNING_POLICY,
    now = () => new Date(),
  }: ContextPreparationOptions) {
    assertToolResultPruningPolicy(toolResultPruning);
    this.compactor = compactor;
    this.fixedBudget = budget === undefined ? undefined : resolveContextBudget(budget);
    this.contextWindow = contextWindow;
    this.toolResultPruning = toolResultPruning;
    this.store = contextStateStore;
    this.now = now;
    this.usageAnchors = new ContextUsageAnchorTracker({
      store: contextStateStore,
      now,
    });
  }

  async prepareRequest({
    conversationId,
    getAccessToken,
    modelRequest,
    rebuild,
    signal,
    trigger,
    forceCompact = false,
    onStatus,
  }: ContextPreparationRequest): Promise<ContextModelRequest> {
    const budget = this.resolveBudget();
    const anchor = await this.usageAnchors.load(conversationId);
    const rawBeforeTokens = estimateContextRequestTokens(modelRequest);
    const beforeTokens = calibrateContextTokens(rawBeforeTokens, anchor);
    const initial = this.pruneIfWorthwhile(modelRequest, beforeTokens, anchor, budget);
    let projectionChanged = initial.changed;

    const compacted = await this.compactor.prepare({
      conversationId,
      getAccessToken,
      triggerTokens: budget.compactAt,
      contextTokens: initial.tokens,
      ...(signal === undefined ? {} : { signal }),
      ...(trigger === undefined ? {} : { trigger }),
      ...(forceCompact ? { force: true } : {}),
    });

    let final: ContextModelRequest;
    let finalPruning = compacted
      ? { prunedCount: 0, savedTokens: 0 }
      : { prunedCount: initial.prunedCount, savedTokens: initial.savedTokens };
    if (compacted) {
      projectionChanged = true;
      const rebuilt = await rebuild();
      const rebuiltTokens = estimateContextRequestTokens(rebuilt);
      const rebuiltPruned = this.pruneIfWorthwhile(rebuilt, rebuiltTokens, undefined, budget);
      projectionChanged = projectionChanged || rebuiltPruned.changed;
      final = trimContextRequest(rebuiltPruned.request, budget, {
        targetTokens: budget.postCompactTarget,
        preserveLeadingMessages: 1,
      });
      projectionChanged = projectionChanged || final !== rebuiltPruned.request;
      finalPruning = {
        prunedCount: rebuiltPruned.prunedCount,
        savedTokens: rebuiltPruned.savedTokens,
      };
    } else {
      final = trimContextRequest(initial.request, budget, {
        ...(forceCompact ? { targetTokens: budget.postCompactTarget } : {}),
      });
      projectionChanged = projectionChanged || final !== initial.request;
    }

    const usage: ContextUsage = {
      contextWindow: budget.contextWindow,
      usedTokens: estimateContextRequestTokens(final),
      inputLimit: budget.inputLimit,
      compactAt: budget.compactAt,
      pruneAt: budget.pruneAt,
      pruneTarget: budget.pruneTarget,
      updatedAt: this.now().toISOString(),
    };
    const pruning: ContextPruningStatus | undefined =
      finalPruning.prunedCount > 0
        ? {
            trigger: trigger ?? "auto",
            prunedCount: finalPruning.prunedCount,
            savedTokens: finalPruning.savedTokens,
            updatedAt: usage.updatedAt,
          }
        : undefined;
    await this.saveStatus(conversationId, usage, pruning);

    this.usageAnchors.stage(conversationId, {
      estimatedTokens: usage.usedTokens,
      projectionChanged,
    });
    if (onStatus) {
      try {
        await onStatus();
      } catch (error) {
        console.warn("[context-preparation] status publish failed", {
          conversationId,
          error: errorText(error),
        });
      }
    }
    return final;
  }

  /** 消费 run 事件：首步 usage 成功后写入锚点，失败或投影变化后清理。 */
  /** provider 超限后的唯一兜底入口：强制压缩并按软目标裁剪，调用方只允许重试一次。 */
  recoverRequest(
    request: Omit<ContextPreparationRequest, "forceCompact">,
  ): Promise<ContextModelRequest> {
    return this.prepareRequest({ ...request, forceCompact: true });
  }

  async recordRunEvent(conversationId: string, event: AgentEvent): Promise<void> {
    await this.usageAnchors.recordRunEvent(conversationId, event);
  }

  private resolveBudget(): ResolvedContextBudget {
    if (this.fixedBudget !== undefined) return this.fixedBudget;
    const contextWindow = this.contextWindow?.();
    return contextWindow === undefined
      ? resolveContextBudget()
      : resolveContextBudget(contextBudgetPolicyForWindow(contextWindow));
  }

  private async saveStatus(
    conversationId: string,
    usage: ContextUsage,
    pruning: ContextPruningStatus | undefined,
  ): Promise<void> {
    try {
      const state = (await this.store.loadContextState(conversationId)) ?? { checkpoints: [] };
      const { pruning: _previousPruning, ...rest } = state;
      await this.store.saveContextState(conversationId, {
        ...rest,
        usage,
        ...(pruning ? { pruning } : {}),
      });
    } catch (error) {
      console.warn("[context-preparation] status save failed", {
        conversationId,
        error: errorText(error),
      });
    }
  }

  /** 只有达到清理触发点且净节省达到门槛时才替换请求；重建后重复同一判断。 */
  private pruneIfWorthwhile(
    request: ContextModelRequest,
    tokens: number,
    anchor: ContextUsageAnchor | undefined,
    budget: ResolvedContextBudget,
  ): {
    request: ContextModelRequest;
    tokens: number;
    changed: boolean;
    prunedCount: number;
    savedTokens: number;
  } {
    if (tokens < budget.pruneAt) {
      return { request, tokens, changed: false, prunedCount: 0, savedTokens: 0 };
    }
    const estimateTokens = anchor
      ? (value: ContextModelRequest) =>
          calibrateContextTokens(estimateContextRequestTokens(value), anchor)
      : estimateContextRequestTokens;
    const result = pruneOldToolResults({
      request,
      targetTokens: budget.pruneTarget,
      policy: this.toolResultPruning,
      estimateTokens,
    });
    if (result.savedTokens < budget.minPruneSaving) {
      return { request, tokens, changed: false, prunedCount: 0, savedTokens: 0 };
    }
    return {
      request: result.request,
      tokens: estimateContextRequestTokens(result.request),
      changed: true,
      prunedCount: result.prunedCount,
      savedTokens: result.savedTokens,
    };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "上下文状态写入失败";
}

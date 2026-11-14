/** 最终模型请求的上下文准备编排：usage 校准、旧工具结果清理、摘要压缩、重建与硬兜底裁剪。 */
import {
  type ContextCompactionTrigger,
  type ContextPruningStatus,
  type ContextUsage,
  MANUAL_COMPACTION_INSTRUCTIONS_MAX_CHARS,
  type ManualCompactionResult,
} from "@answra/shared";
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
  /** 手动操作可越过失败熔断；自动与 provider 超限恢复不得越过。 */
  bypassFailureBreaker?: boolean;
  /** 手动 `/compact` 的一次性摘要偏好；自动与恢复路径不传。 */
  compactionInstructions?: string;
  /** 状态已写入 store 后通知宿主推�?snapshot；失败不影响本轮模型请求�?*/
  onStatus?: () => void | Promise<void>;
}

export type ManualCompactionRequest = Omit<
  ContextPreparationRequest,
  "forceCompact" | "trigger" | "bypassFailureBreaker"
>;

interface PreparedContext {
  request: ContextModelRequest;
  compaction: Awaited<ReturnType<ContextCompactor["prepare"]>>;
  usage: ContextUsage;
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

  async prepareRequest(input: ContextPreparationRequest): Promise<ContextModelRequest> {
    return (await this.prepare(input)).request;
  }

  /** 手动压缩：强制触发、绕过失败熔断，并在压缩后刷新 usage。 */
  async compactNow(input: ManualCompactionRequest): Promise<ManualCompactionResult> {
    const instructions = normalizeCompactionInstructions(input.compactionInstructions);
    const prepared = await this.prepare({
      ...input,
      ...(instructions === undefined ? {} : { compactionInstructions: instructions }),
      forceCompact: true,
      trigger: "manual",
      bypassFailureBreaker: true,
    });
    return manualCompactionResult(prepared.compaction, prepared.usage);
  }

  private async prepare({
    conversationId,
    getAccessToken,
    modelRequest,
    rebuild,
    signal,
    trigger,
    forceCompact = false,
    bypassFailureBreaker = false,
    compactionInstructions,
    onStatus,
  }: ContextPreparationRequest): Promise<PreparedContext> {
    const budget = this.resolveBudget();
    const anchor = await this.usageAnchors.load(conversationId);
    const rawBeforeTokens = estimateContextRequestTokens(modelRequest);
    const beforeTokens = calibrateContextTokens(rawBeforeTokens, anchor);
    const initial = this.pruneIfWorthwhile(modelRequest, beforeTokens, anchor, budget);
    let projectionChanged = initial.changed;

    const compaction = await this.compactor.prepare({
      conversationId,
      getAccessToken,
      triggerTokens: budget.compactAt,
      contextTokens: initial.tokens,
      ...(signal === undefined ? {} : { signal }),
      ...(trigger === undefined ? {} : { trigger }),
      ...(forceCompact ? { force: true } : {}),
      ...(bypassFailureBreaker ? { bypassFailureBreaker: true } : {}),
      ...(compactionInstructions === undefined ? {} : { instructions: compactionInstructions }),
    });

    let final: ContextModelRequest;
    let finalPruning =
      compaction.status === "compacted"
        ? { prunedCount: 0, savedTokens: 0 }
        : { prunedCount: initial.prunedCount, savedTokens: initial.savedTokens };
    if (compaction.status === "compacted") {
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
    return { request: final, compaction, usage };
  }

  /** 消费 run 事件：首步 usage 成功后写入锚点，失败或投影变化后清理。 */
  /**
   * provider 超限后的唯一兜底入口：强制压缩并按软目标裁剪。
   * 只有真正完成压缩才返回可重试请求；熔断、失败、取消都返回 undefined。
   */
  async recoverRequest(
    request: Omit<ContextPreparationRequest, "forceCompact">,
  ): Promise<ContextModelRequest | undefined> {
    const prepared = await this.prepare({ ...request, forceCompact: true });
    return prepared.compaction.status === "compacted" ? prepared.request : undefined;
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

function manualCompactionResult(
  compaction: PreparedContext["compaction"],
  usage: ContextUsage,
): ManualCompactionResult {
  switch (compaction.status) {
    case "compacted":
      return { status: "compacted", usage };
    case "skipped":
      return { status: "skipped", reason: compaction.reason };
    case "failed":
      return { status: "failed", errorText: compaction.errorText, usage };
    case "aborted":
      return { status: "aborted" };
  }
}

function normalizeCompactionInstructions(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MANUAL_COMPACTION_INSTRUCTIONS_MAX_CHARS) {
    throw new Error(`压缩指令不能超过 ${MANUAL_COMPACTION_INSTRUCTIONS_MAX_CHARS} 个字符`);
  }
  return trimmed;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "上下文状态写入失败";
}

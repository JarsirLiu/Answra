/** 模型输入 usage 的会话状态协调：维护校准锚点并持久化 provider 实测值。 */
import type { ContextPruningStatus, ContextUsage, TurnOutcome } from "@answra/shared";
import { type ContextStateStore, ContextUsageAnchorTracker } from "./usageAnchor";

export class ContextStateCoordinator {
  private readonly store: ContextStateStore;
  private readonly now: () => Date;
  private readonly anchors: ContextUsageAnchorTracker;

  constructor({ store, now = () => new Date() }: { store: ContextStateStore; now?: () => Date }) {
    this.store = store;
    this.now = now;
    this.anchors = new ContextUsageAnchorTracker({ store, now });
  }

  stage(
    conversationId: string,
    input: { estimatedTokens: number; projectionChanged: boolean },
  ): void {
    this.anchors.stage(conversationId, input);
  }

  async savePreparedStatus(
    conversationId: string,
    usage: ContextUsage,
    pruning: ContextPruningStatus | undefined,
    prunedToolCallIds: readonly string[],
  ): Promise<void> {
    try {
      const state = (await this.store.loadContextState(conversationId)) ?? { checkpoints: [] };
      const {
        pruning: _previousPruning,
        prunedToolCallIds: _previousPrunedToolCallIds,
        ...rest
      } = state;
      await this.store.saveContextState(conversationId, {
        ...rest,
        usage,
        ...(pruning ? { pruning } : {}),
        ...(prunedToolCallIds.length > 0 ? { prunedToolCallIds } : {}),
      });
    } catch (error) {
      console.warn("[context-preparation] status save failed", {
        conversationId,
        error: errorText(error, "上下文状态写入失败"),
      });
    }
  }

  /**
   * step 结算：锚点只认首个 step 的首个请求；展示取最后一个请求的输入量。
   *
   * 一个 step 内可能有多轮工具循环，把多请求之和当上下文占用会让 UI 出现远超窗口的数字，
   * 并让锚点比例被放大数十倍。
   */
  async recordStepFinished(
    conversationId: string,
    input: { index: number; anchorInputTokens?: number; contextInputTokens?: number },
  ): Promise<void> {
    this.anchors.recordStepFinished(conversationId, {
      index: input.index,
      ...(input.anchorInputTokens === undefined ? {} : { inputTokens: input.anchorInputTokens }),
    });
    if (input.contextInputTokens === undefined) return;
    try {
      const state = await this.store.loadContextState(conversationId);
      if (!state?.usage) return;
      await this.store.saveContextState(conversationId, {
        ...state,
        usage: {
          ...state.usage,
          usedTokens: input.contextInputTokens,
          source: "provider",
          updatedAt: this.now().toISOString(),
        },
      });
    } catch (error) {
      console.warn("[context-usage] provider usage save failed", {
        conversationId,
        error: errorText(error, "provider usage 写入失败"),
      });
    }
  }

  /** Turn 终态：成功提交锚点，失败或中断丢弃并清理受影响的投影。 */
  async recordTurnFinished(conversationId: string, outcome: TurnOutcome): Promise<void> {
    await this.anchors.recordTurnFinished(conversationId, outcome);
  }
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

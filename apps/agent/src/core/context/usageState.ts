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
   * 每次 provider 请求结算：把这次请求的输入量写成当前上下文占用。
   *
   * 展示必须跟每次请求走：一个 step 内可能有 20 多轮工具循环，只在 step 结算时写
   * 会让状态行整段停滞，甚至直到 Turn 收口前都没有 `ctx`。
   */
  async recordRequestUsage(conversationId: string, inputTokens: number): Promise<void> {
    try {
      const state = await this.store.loadContextState(conversationId);
      if (!state?.usage) return;
      await this.store.saveContextState(conversationId, {
        ...state,
        usage: {
          ...state.usage,
          usedTokens: inputTokens,
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

  /** step 结算：锚点取 Turn 内首个成功请求；展示由每次请求自行写入。 */
  async recordStepFinished(
    conversationId: string,
    input: { index: number; anchorInputTokens?: number },
  ): Promise<void> {
    this.anchors.recordStepFinished(conversationId, {
      index: input.index,
      ...(input.anchorInputTokens === undefined ? {} : { inputTokens: input.anchorInputTokens }),
    });
  }

  /** Turn 终态：成功提交锚点，失败或中断丢弃并清理受影响的投影。 */
  async recordTurnFinished(conversationId: string, outcome: TurnOutcome): Promise<void> {
    await this.anchors.recordTurnFinished(conversationId, outcome);
  }
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

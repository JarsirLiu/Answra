/** 模型输入 usage 的会话状态协调：维护校准锚点并持久化 provider 实测值。 */
import type { ContextPruningStatus, ContextUsage } from "@answra/shared";
import type { AgentEvent } from "@answra/shared/schema";
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

  async recordRunEvent(conversationId: string, event: AgentEvent): Promise<void> {
    await this.anchors.recordRunEvent(conversationId, event);
    if (event.type !== "context-usage-changed") return;

    try {
      const state = await this.store.loadContextState(conversationId);
      if (!state?.usage) return;
      await this.store.saveContextState(conversationId, {
        ...state,
        usage: {
          ...state.usage,
          usedTokens: event.usedTokens,
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
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

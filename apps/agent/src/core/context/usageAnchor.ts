/** usage 锚点生命周期：记录成功 run 首个 step 的实际输入 token，并在投影或 run 失效后清理。 */
import type { TurnOutcome } from "@answra/shared/schema";
import type { ContextState, ContextUsageAnchor } from "../transcript/contextState";
import type { ConversationStore } from "../transcript/store";

export type ContextStateStore = Pick<ConversationStore, "loadContextState" | "saveContextState">;

interface PendingUsageAnchor {
  estimatedTokens: number;
  projectionChanged: boolean;
  inputTokens?: number;
}

/** 只保存内存中的待定锚点；成功后写入 ContextState，失败或中断时丢弃。 */
export class ContextUsageAnchorTracker {
  private readonly store: ContextStateStore;
  private readonly now: () => Date;
  private readonly pending = new Map<string, PendingUsageAnchor>();

  constructor({ store, now = () => new Date() }: { store: ContextStateStore; now?: () => Date }) {
    this.store = store;
    this.now = now;
  }

  /** 在请求发出前登记本轮最终投影的原始估算与是否发生投影变化。 */
  stage(
    conversationId: string,
    {
      estimatedTokens,
      projectionChanged,
    }: {
      estimatedTokens: number;
      projectionChanged: boolean;
    },
  ): void {
    this.pending.set(conversationId, { estimatedTokens, projectionChanged });
  }

  /** 消费 step 结算：首个 step 记录实际输入 token；Turn 终态决定提交或清理锚点。 */
  recordStepFinished(conversationId: string, input: { index: number; inputTokens?: number }): void {
    if (input.index !== 0) return;
    const pending = this.pending.get(conversationId);
    if (pending && input.inputTokens !== undefined && input.inputTokens > 0) {
      pending.inputTokens = input.inputTokens;
    }
  }

  async recordTurnFinished(conversationId: string, outcome: TurnOutcome): Promise<void> {
    if (outcome === "completed") await this.commit(conversationId);
    else await this.discard(conversationId);
  }

  private async commit(conversationId: string): Promise<void> {
    const pending = this.pending.get(conversationId);
    this.pending.delete(conversationId);
    if (!pending) return;
    if (pending.inputTokens === undefined || pending.estimatedTokens <= 0) {
      if (pending.projectionChanged) await this.clear(conversationId);
      return;
    }
    await this.save(conversationId, {
      inputTokens: pending.inputTokens,
      estimatedTokens: pending.estimatedTokens,
      createdAt: this.now().toISOString(),
    });
  }

  private async discard(conversationId: string): Promise<void> {
    const pending = this.pending.get(conversationId);
    this.pending.delete(conversationId);
    if (pending?.projectionChanged) await this.clear(conversationId);
  }

  private async save(conversationId: string, anchor: ContextUsageAnchor): Promise<void> {
    try {
      const state = (await this.store.loadContextState(conversationId)) ?? { checkpoints: [] };
      await this.store.saveContextState(conversationId, { ...state, usageAnchor: anchor });
    } catch (error) {
      console.warn("[context-usage] anchor save failed", {
        conversationId,
        error: errorText(error),
      });
    }
  }

  private async clear(conversationId: string): Promise<void> {
    try {
      const state: ContextState | undefined = await this.store.loadContextState(conversationId);
      if (!state?.usageAnchor) return;
      const { usageAnchor: _usageAnchor, ...rest } = state;
      await this.store.saveContextState(conversationId, rest);
    } catch (error) {
      console.warn("[context-usage] anchor clear failed", {
        conversationId,
        error: errorText(error),
      });
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "usage 锚点写入失败";
}

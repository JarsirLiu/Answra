/** 将模型事件串行写入唯一 ExecutionStore，并维护仅供诊断的回合指标。 */
import type { AgentStreamEvent } from "@answra/shared/schema";
import type { ConversationStore } from "../session/store";

/** 一个回合的流统计；只用于诊断，不进入跨进程 schema。 */
export interface TurnMetrics {
  readonly chunkCounts: Record<string, number>;
  readonly textLength: number;
  readonly reasoningLength: number;
  readonly started: boolean;
  readonly failed: boolean;
}

export function createStreamJournal({
  conversationId,
  runId,
  store,
  executionStore,
}: {
  conversationId: string;
  runId: string;
  store: ConversationStore;
  executionStore: import("../../execution/store").ExecutionStore;
}) {
  const chunkCounts: Record<string, number> = {};
  const textPartLengths = new Map<string, number>();
  const reasoningPartLengths = new Map<string, number>();
  let textLength = 0;
  let reasoningLength = 0;
  let started = false;
  let failed = false;

  return {
    async append(stream: AgentStreamEvent): Promise<void> {
      chunkCounts[stream.type] = (chunkCounts[stream.type] ?? 0) + 1;
      if (Object.keys(chunkCounts).length === 1 && chunkCounts[stream.type] === 1)
        console.info("[conversation][run] first chunk", { runId, type: stream.type });
      if (stream.type === "text-delta") {
        textLength += stream.delta.length;
        textPartLengths.set(
          stream.partId,
          (textPartLengths.get(stream.partId) ?? 0) + stream.delta.length,
        );
      }
      if (stream.type === "reasoning-delta") {
        reasoningLength += stream.delta.length;
        reasoningPartLengths.set(
          stream.partId,
          (reasoningPartLengths.get(stream.partId) ?? 0) + stream.delta.length,
        );
      }
      if (stream.type === "text-end") {
        console.info("[conversation][run] text part finished", {
          runId,
          partId: stream.partId,
          length: textPartLengths.get(stream.partId) ?? 0,
        });
        textPartLengths.delete(stream.partId);
      }
      if (stream.type === "reasoning-end") {
        console.info("[conversation][run] reasoning part finished", {
          runId,
          partId: stream.partId,
          length: reasoningPartLengths.get(stream.partId) ?? 0,
        });
        reasoningPartLengths.delete(stream.partId);
      }
      if (
        stream.type === "tool-call" ||
        stream.type === "tool-result" ||
        stream.type === "tool-error"
      ) {
        console.info(`[conversation][run] ${stream.type}`, {
          runId,
          toolCallId: stream.toolCallId,
          ...(stream.type === "tool-call" ? { toolName: stream.toolName } : {}),
          ...(stream.type === "tool-error" ? { errorText: stream.errorText } : {}),
        });
      }
      if (stream.type === "error") {
        console.error("[conversation][run] stream error", { runId, errorText: stream.errorText });
      }
      await executionStore.appendEvent(runId, stream);
      await store.applyStreamEvent(conversationId, runId, stream);
      if (stream.type === "start") started = true;
      if (stream.type === "error") failed = true;
    },

    get metrics(): TurnMetrics {
      return { chunkCounts, textLength, reasoningLength, started, failed };
    },
  };
}

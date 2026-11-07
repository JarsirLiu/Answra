/** 将 fullStream 事件串行写入唯一 ExecutionStore，并维护回合终态指标。 */
import type { AgentEvent, AgentStreamEvent } from "@answra/shared/schema";
import type { ConversationStore } from "../session/store";

/** 一个回合的流统计；只用于诊断，不进入跨进程 schema。 */
export interface TurnMetrics {
  readonly chunkCounts: Record<string, number>;
  readonly textLength: number;
  readonly reasoningLength: number;
  readonly started: boolean;
  readonly failed: boolean;
  readonly finished: boolean;
  readonly aborted: boolean;
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
  let finished = false;
  let aborted = false;

  return {
    async append(event: AgentEvent): Promise<void> {
      chunkCounts[event.type] = (chunkCounts[event.type] ?? 0) + 1;
      if (Object.keys(chunkCounts).length === 1 && chunkCounts[event.type] === 1)
        console.info("[conversation][run] first event", { runId, type: event.type });
      if (event.type === "text-delta") {
        textLength += event.delta.length;
        textPartLengths.set(
          event.partId,
          (textPartLengths.get(event.partId) ?? 0) + event.delta.length,
        );
      }
      if (event.type === "reasoning-delta") {
        reasoningLength += event.delta.length;
        reasoningPartLengths.set(
          event.partId,
          (reasoningPartLengths.get(event.partId) ?? 0) + event.delta.length,
        );
      }
      if (event.type === "text-end") {
        console.info("[conversation][run] text part finished", {
          runId,
          partId: event.partId,
          length: textPartLengths.get(event.partId) ?? 0,
        });
        textPartLengths.delete(event.partId);
      }
      if (event.type === "reasoning-end") {
        console.info("[conversation][run] reasoning part finished", {
          runId,
          partId: event.partId,
          length: reasoningPartLengths.get(event.partId) ?? 0,
        });
        reasoningPartLengths.delete(event.partId);
      }
      if (
        event.type === "tool-call" ||
        event.type === "tool-result" ||
        event.type === "tool-error" ||
        event.type === "tool-output-denied" ||
        event.type === "tool-approval-request"
      ) {
        console.info(`[conversation][run] ${event.type}`, {
          runId,
          toolCallId: event.toolCallId,
          ...("toolName" in event ? { toolName: event.toolName } : {}),
          ...(event.type === "tool-error" ? { errorText: event.errorText } : {}),
        });
      }
      if (event.type === "error") {
        console.error("[conversation][run] stream error", { runId, errorText: event.errorText });
      }
      const stepId =
        event.type === "step-started" || event.type === "step-finished" ? event.stepId : undefined;
      await executionStore.appendEvent(runId, event, stepId ? { stepId } : undefined);
      if (isStreamEvent(event)) await store.applyStreamEvent(conversationId, runId, event);
      if (event.type === "start") started = true;
      if (event.type === "finish") {
        finished = true;
        if (event.finishReason === "error") failed = true;
      }
      if (event.type === "abort") aborted = true;
      if (event.type === "error") failed = true;
    },

    get metrics(): TurnMetrics {
      return {
        chunkCounts,
        textLength,
        reasoningLength,
        started,
        failed,
        finished,
        aborted,
      };
    },
  };
}

function isStreamEvent(event: AgentEvent): event is AgentStreamEvent {
  return (
    event.type !== "run-state-changed" &&
    event.type !== "step-started" &&
    event.type !== "step-finished" &&
    event.type !== "part-state-changed"
  );
}

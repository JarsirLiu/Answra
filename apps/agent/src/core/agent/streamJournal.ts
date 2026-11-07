/** 串行追加现有 AgentEvent 到 ExecutionStore 并通知领域订阅者；不写 transcript。 */
import type { AgentEvent, AgentEventEnvelope } from "@answra/shared/schema";
import type { ExecutionEventMetadata, ExecutionStore } from "../../execution/store";

export interface RunMetrics {
  readonly chunkCounts: Record<string, number>;
  readonly textLength: number;
  readonly reasoningLength: number;
  readonly started: boolean;
  readonly failed: boolean;
  readonly finished: boolean;
  readonly aborted: boolean;
}

export function createExecutionJournal({
  runId,
  executionStore,
  onEvent,
}: {
  runId: string;
  executionStore: ExecutionStore;
  onEvent: (event: AgentEventEnvelope) => Promise<void>;
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

  async function notify(envelope: AgentEventEnvelope): Promise<void> {
    await onEvent(envelope);
    const event = envelope.event;
    if (event.type === "start") started = true;
    if (event.type === "finish") {
      finished = true;
      if (event.finishReason === "error") failed = true;
    }
    if (event.type === "abort") aborted = true;
    if (event.type === "error") failed = true;
  }

  return {
    async append(event: AgentEvent): Promise<void> {
      chunkCounts[event.type] = (chunkCounts[event.type] ?? 0) + 1;
      if (Object.keys(chunkCounts).length === 1 && chunkCounts[event.type] === 1)
        console.info("[agent][run] first event", { runId, type: event.type });
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
        console.info("[agent][run] text part finished", {
          runId,
          partId: event.partId,
          length: textPartLengths.get(event.partId) ?? 0,
        });
        textPartLengths.delete(event.partId);
      }
      if (event.type === "reasoning-end") {
        console.info("[agent][run] reasoning part finished", {
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
        console.info(`[agent][run] ${event.type}`, {
          runId,
          toolCallId: event.toolCallId,
          ...("toolName" in event ? { toolName: event.toolName } : {}),
          ...(event.type === "tool-error" ? { errorText: event.errorText } : {}),
        });
      }
      if (event.type === "error")
        console.error("[agent][run] stream error", { runId, errorText: event.errorText });
      const metadata: ExecutionEventMetadata =
        event.type === "step-started" || event.type === "step-finished"
          ? { stepId: event.stepId }
          : {};
      await notify(await executionStore.appendEvent(runId, event, metadata));
    },

    async notify(envelope: AgentEventEnvelope): Promise<void> {
      await notify(envelope);
    },

    get metrics(): RunMetrics {
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

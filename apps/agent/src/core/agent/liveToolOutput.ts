/** 工具实时输出的有界串行中继：保证增量先于工具终态写入，不决定 run/step 状态。 */
import type { AgentStreamEvent } from "@answra/shared/schema";

/** 单次工具调用实时输出的字符上限，避免长命令把事件日志撑爆。 */
export const MAX_LIVE_TOOL_OUTPUT_CHARS = 8_000;

export interface AgentEventWriter {
  append(event: AgentStreamEvent): Promise<void>;
}

/**
 * Serializes live tool output into the writer so deltas always precede the tool's
 * terminal event. Deltas are capped per tool call; the final result still carries
 * the full (budgeted) output.
 */
export function createLiveToolOutputRelay(writer: AgentEventWriter) {
  let chain: Promise<void> = Promise.resolve();
  const emittedChars = new Map<string, number>();
  return {
    emit(toolCallId: string, delta: string): void {
      if (!delta) return;
      const emitted = emittedChars.get(toolCallId) ?? 0;
      if (emitted >= MAX_LIVE_TOOL_OUTPUT_CHARS) return;
      const room = MAX_LIVE_TOOL_OUTPUT_CHARS - emitted;
      const chunk = delta.length > room ? delta.slice(0, room) : delta;
      emittedChars.set(toolCallId, emitted + chunk.length);
      chain = chain
        .then(() => writer.append({ type: "tool-output-delta", toolCallId, delta: chunk }))
        .catch(() => undefined);
    },
    flush(): Promise<void> {
      return chain;
    },
  };
}

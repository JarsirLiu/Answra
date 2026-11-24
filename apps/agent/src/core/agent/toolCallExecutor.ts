/** 执行单次模型响应中的已授权工具调用；不发起模型请求或决定 Turn 是否继续。 */
import type { AgentStreamEvent } from "@answra/shared/schema";
import type { ModelMessage, ToolSet } from "ai";
import type { StepEventSink } from "../session/contracts";

export interface ModelToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ToolCallExecutionOptions {
  tools: ToolSet | undefined;
  calls: readonly ModelToolCall[];
  messages: ModelMessage[];
  signal: AbortSignal;
  events: StepEventSink;
  flushOutput: () => Promise<void>;
}

export async function executeModelToolCalls({
  tools,
  calls,
  messages,
  signal,
  events,
  flushOutput,
}: ToolCallExecutionOptions): Promise<"completed" | "aborted"> {
  for (const call of calls) {
    if (signal.aborted) return "aborted";
    const definition = tools?.[call.toolName];
    const startedAt = Date.now();
    await events.append({
      type: "tool-execution-started",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
    });

    if (definition?.execute === undefined)
      throw new Error(`工具没有已授权的本地执行器：${call.toolName}`);

    let output: unknown;
    try {
      output = await definition.execute(call.input, {
        toolCallId: call.toolCallId,
        messages,
        abortSignal: signal,
      });
    } catch (error) {
      await flushOutput();
      if (signal.aborted) return "aborted";
      throw error;
    }

    await flushOutput();
    await appendToolFinish(events, call, {
      output,
      durationMs: Date.now() - startedAt,
    });
  }

  return "completed";
}

async function appendToolFinish(
  events: StepEventSink,
  call: ModelToolCall,
  result: { output: unknown; durationMs: number },
): Promise<void> {
  const common = {
    type: "tool-execution-finished" as const,
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
    durationMs: Math.max(0, Math.round(result.durationMs)),
  };
  const event: AgentStreamEvent = {
    ...common,
    result: { success: true, output: result.output },
  };
  await events.append(event);
}

/** 单次模型尝试的事件缓冲与流终态识别；不决定上下文恢复策略。 */
import type { AgentEvent } from "@answra/shared/schema";
import type { TextStreamPart, ToolSet } from "ai";
import { modelErrorText, normalizeStreamPart } from "../model/streamEvents";

export type ModelAttemptResult =
  | { kind: "finished" }
  | { kind: "aborted" }
  | { kind: "failed"; error: unknown; errorText: string };

export interface ModelAttemptSink {
  append(event: AgentEvent): Promise<void>;
  flush(): Promise<void>;
  discard(): void;
  readonly hasContent: boolean;
}

interface EventWriter {
  append(event: AgentEvent): Promise<void>;
}

/**
 * 在模型产生第一段可观察内容前只缓存生命周期事件。恢复时丢弃缓存，
 * 避免同一次 run 留下两次 start/step-started；一旦出现内容就立即落盘。
 */
export function createModelAttemptSink(writer: EventWriter): ModelAttemptSink {
  let buffered: AgentEvent[] = [];
  let hasContent = false;

  async function flush(): Promise<void> {
    if (buffered.length === 0) return;
    const events = buffered;
    buffered = [];
    for (const event of events) await writer.append(event);
  }

  return {
    async append(event: AgentEvent): Promise<void> {
      if (hasContent) {
        await writer.append(event);
        return;
      }
      if (isPreludeEvent(event)) {
        buffered.push(event);
        return;
      }
      await flush();
      if (!isTerminalEvent(event)) hasContent = true;
      await writer.append(event);
    },
    flush,
    discard(): void {
      buffered = [];
    },
    get hasContent(): boolean {
      return hasContent;
    },
  };
}

/**
 * 消费一次 provider 流。错误 part 不立即写入 journal，由调用方决定是否恢复；
 * 流提前结束时返回稳定的“无终态”错误，不伪造 provider 错误文本。
 */
export async function consumeModelAttempt(
  parts: AsyncIterable<TextStreamPart<ToolSet>>,
  sink: ModelAttemptSink,
): Promise<ModelAttemptResult> {
  let stepIndex = -1;
  for await (const part of parts) {
    if (part.type === "start-step") stepIndex += 1;
    if (part.type === "error") {
      return { kind: "failed", error: part.error, errorText: modelErrorText(part.error) };
    }
    const normalized = normalizeStreamPart(part, { stepIndex });
    if (normalized === undefined) continue;
    for (const event of Array.isArray(normalized) ? normalized : [normalized]) {
      await sink.append(event);
      if (event.type === "abort") return { kind: "aborted" };
      if (event.type === "finish") return { kind: "finished" };
    }
  }
  return { kind: "failed", error: undefined, errorText: "模型流未提供终态" };
}

function isPreludeEvent(event: AgentEvent): boolean {
  return (
    event.type === "start" ||
    event.type === "step-started" ||
    event.type === "text-start" ||
    event.type === "reasoning-start" ||
    event.type === "model-warning-unsupported" ||
    event.type === "model-warning-compatibility" ||
    event.type === "model-warning-other"
  );
}

function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === "finish" || event.type === "abort";
}

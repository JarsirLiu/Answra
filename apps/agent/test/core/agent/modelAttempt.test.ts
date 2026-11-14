import type { AgentEvent } from "@answra/shared/schema";
import type { TextStreamPart, ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { consumeModelAttempt, createModelAttemptSink } from "../../../src/core/agent/modelAttempt";

function part(value: object): TextStreamPart<ToolSet> {
  return value as TextStreamPart<ToolSet>;
}

async function* stream(parts: readonly TextStreamPart<ToolSet>[]) {
  for (const item of parts) yield item;
}

function createWriter() {
  const events: AgentEvent[] = [];
  return {
    events,
    async append(event: AgentEvent): Promise<void> {
      events.push(event);
    },
  };
}

describe("model attempt sink", () => {
  it("buffers pre-content lifecycle and flushes it before the first content event", async () => {
    const writer = createWriter();
    const sink = createModelAttemptSink(writer);

    await sink.append({ type: "start" });
    await sink.append({ type: "step-started", stepId: "step-0", index: 0 });
    await sink.append({ type: "model-warning-other", message: "compat" });

    expect(writer.events).toEqual([]);
    expect(sink.hasContent).toBe(false);

    await sink.append({ type: "text-delta", partId: "text", delta: "hello" });

    expect(writer.events.map((event) => event.type)).toEqual([
      "start",
      "step-started",
      "model-warning-other",
      "text-delta",
    ]);
    expect(sink.hasContent).toBe(true);
  });

  it("discards buffered lifecycle without writing when an attempt is abandoned", async () => {
    const writer = createWriter();
    const sink = createModelAttemptSink(writer);

    await sink.append({ type: "start" });
    await sink.append({ type: "step-started", stepId: "step-0", index: 0 });
    sink.discard();
    await sink.append({ type: "text-delta", partId: "text", delta: "retry" });

    expect(writer.events).toEqual([{ type: "text-delta", partId: "text", delta: "retry" }]);
    expect(sink.hasContent).toBe(true);
  });

  it("returns the raw provider error without writing a terminal error event", async () => {
    const writer = createWriter();
    const sink = createModelAttemptSink(writer);
    const error = new Error("maximum context length exceeded");

    const result = await consumeModelAttempt(
      stream([part({ type: "start" }), part({ type: "error", error })]),
      sink,
    );

    expect(result).toEqual({
      kind: "failed",
      error,
      errorText: "maximum context length exceeded",
    });
    expect(writer.events).toEqual([]);
  });

  it("marks content before a later provider error so the caller cannot recover", async () => {
    const writer = createWriter();
    const sink = createModelAttemptSink(writer);
    const error = new Error("maximum context length exceeded");

    const result = await consumeModelAttempt(
      stream([
        part({ type: "start" }),
        part({ type: "text-start", id: "text" }),
        part({ type: "text-delta", id: "text", text: "partial" }),
        part({ type: "error", error }),
      ]),
      sink,
    );

    expect(result).toEqual({
      kind: "failed",
      error,
      errorText: "maximum context length exceeded",
    });
    expect(sink.hasContent).toBe(true);
    expect(writer.events.map((event) => event.type)).toEqual(["start", "text-start", "text-delta"]);
  });

  it("writes an abort terminal and flushes buffered lifecycle", async () => {
    const writer = createWriter();
    const sink = createModelAttemptSink(writer);

    const result = await consumeModelAttempt(
      stream([part({ type: "start" }), part({ type: "abort", reason: "cancelled" })]),
      sink,
    );

    expect(result).toEqual({ kind: "aborted" });
    expect(writer.events).toEqual([{ type: "start" }, { type: "abort", reason: "cancelled" }]);
  });

  it("reports a finished stream and keeps terminal events in order", async () => {
    const writer = createWriter();
    const sink = createModelAttemptSink(writer);

    const result = await consumeModelAttempt(
      stream([
        part({ type: "start" }),
        part({ type: "start-step", warnings: [] }),
        part({ type: "text-start", id: "text" }),
        part({ type: "text-delta", id: "text", text: "done" }),
        part({ type: "text-end", id: "text" }),
        part({
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        }),
      ]),
      sink,
    );

    expect(result).toEqual({ kind: "finished" });
    expect(writer.events.map((event) => event.type)).toEqual([
      "start",
      "step-started",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
  });

  it("reports an explicit failure when the stream closes without a terminal event", async () => {
    const writer = createWriter();
    const sink = createModelAttemptSink(writer);

    const result = await consumeModelAttempt(stream([part({ type: "start" })]), sink);

    expect(result).toEqual({
      kind: "failed",
      error: undefined,
      errorText: "模型流未提供终态",
    });
    expect(writer.events).toEqual([]);
  });
});

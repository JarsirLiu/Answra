import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defineTool,
  executeToolCall,
  type ToolContext,
  type ToolEntry,
  type ToolMetadata,
  toolId,
} from "../../../src/core/tool";

const BASE_METADATA: ToolMetadata = {
  name: "Test",
  description: "test tool",
  readOnly: true,
  destructive: false,
  concurrentSafe: true,
  sideEffectScope: "none",
  timeoutMs: 1_000,
  maxOutputBytes: 1_024,
  resultBudget: { strategy: "inline", maxModelChars: 1_024 },
};

function metadata(name: string, overrides: Partial<ToolMetadata> = {}): ToolMetadata {
  return { ...BASE_METADATA, name, ...overrides };
}

function testTool<Input, Output>(
  handler: ToolEntry<Input, Output>["handler"],
  overrides: Partial<ToolEntry<Input, Output>> = {},
): ToolEntry<Input, Output> {
  return defineTool<Input, Output>({
    id: toolId("test.tool"),
    metadata: metadata("Test"),
    inputSchema: { type: "object" },
    handler,
    ...overrides,
  });
}

function context(signal: AbortSignal = new AbortController().signal): ToolContext {
  return {
    toolCallId: "tool-call-1",
    signal,
    workspaceRoot: null,
    runId: "run-1",
    sessionId: "session-1",
  };
}

describe("executeToolCall", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the handler output and its model content", async () => {
    const result = await executeToolCall(
      testTool(async () => "hello"),
      {},
      context(),
    );

    expect(result).toMatchObject({
      success: true,
      output: "hello",
      modelContent: "hello",
      truncated: false,
    });
  });

  it("serializes non-string outputs for the model by default", async () => {
    const result = await executeToolCall(
      testTool(async () => ({ value: 1 })),
      {},
      context(),
    );

    expect(result).toMatchObject({ success: true, modelContent: '{"value":1}' });
  });

  it("applies resolveInput before the handler sees the input", async () => {
    const result = await executeToolCall(
      testTool(async (input: { value: string }) => input.value, {
        resolveInput: (input) => ({ value: input.value.trim() }),
      }),
      { value: "  x  " },
      context(),
    );

    expect(result).toMatchObject({ success: true, modelContent: "x" });
  });

  it("uses formatModelContent for the model projection", async () => {
    const result = await executeToolCall(
      testTool(async () => ({ value: 1 }), {
        formatModelContent: (output: { value: number }) => `value=${output.value}`,
      }),
      {},
      context(),
    );

    expect(result).toMatchObject({ success: true, modelContent: "value=1" });
  });

  it("returns a structured failure when validateInput rejects the call", async () => {
    const result = await executeToolCall(
      testTool(async () => "hello", {
        validateInput: () => ({ ok: false, code: "invalid-input", message: "bad input" }),
      }),
      {},
      context(),
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: "invalid-input", message: "bad input" },
    });
  });

  it("returns a structured failure when the handler reports a business failure", async () => {
    const result = await executeToolCall(
      testTool(async () => ({
        ok: false as const,
        code: "handler-failed" as const,
        message: "nope",
      })),
      {},
      context(),
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: "handler-failed", message: "nope" },
    });
  });

  it("propagates infrastructure errors instead of turning them into tool results", async () => {
    await expect(
      executeToolCall(
        testTool(async () => {
          throw new Error("disk failed");
        }),
        {},
        context(),
      ),
    ).rejects.toThrow("disk failed");
  });

  it("turns a handler timeout into a timeout failure", async () => {
    vi.useFakeTimers();
    const pending = executeToolCall(
      testTool(async () => new Promise<string>(() => {}), {
        metadata: metadata("Slow", { timeoutMs: 10 }),
      }),
      {},
      context(),
    );

    await vi.advanceTimersByTimeAsync(20);
    const result = await pending;

    expect(result).toMatchObject({ success: false, error: { code: "timeout" } });
  });

  it("returns aborted before starting when the run signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await executeToolCall(
      testTool(async () => "hello"),
      {},
      context(controller.signal),
    );

    expect(result).toMatchObject({ success: false, error: { code: "aborted" } });
  });

  it("maps an abort raised while the handler runs to an aborted failure", async () => {
    const controller = new AbortController();
    const pending = executeToolCall(
      testTool(
        (_input, toolContext) =>
          new Promise<string>((_resolve, reject) => {
            toolContext.signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      ),
      {},
      context(controller.signal),
    );

    controller.abort();

    expect(await pending).toMatchObject({ success: false, error: { code: "aborted" } });
  });

  it("rejects model content above the byte budget after projection", async () => {
    const result = await executeToolCall(
      testTool(async () => "abcdef", {
        metadata: metadata("Large", { maxOutputBytes: 3 }),
      }),
      {},
      context(),
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: "output-too-large" },
    });
  });

  it("allows structured output whose JSON exceeds the budget when its model projection fits", async () => {
    const result = await executeToolCall(
      testTool(async () => ({ content: "x".repeat(100) }), {
        metadata: metadata("Projected", { maxOutputBytes: 20 }),
        formatModelContent: () => "small",
      }),
      {},
      context(),
    );

    expect(result).toMatchObject({ success: true, modelContent: "small" });
  });

  it("truncates model content to the configured character budget", async () => {
    const result = await executeToolCall(
      testTool(async () => "abcdef", {
        metadata: metadata("Trimmed", {
          resultBudget: { strategy: "truncate", maxModelChars: 3 },
        }),
      }),
      {},
      context(),
    );

    expect(result).toMatchObject({
      success: true,
      output: "abcdef",
      modelContent: "abc\n[输出已截断]",
      truncated: true,
    });
  });

  it("keeps the full output under the inline budget", async () => {
    const result = await executeToolCall(
      testTool(async () => "abcdef", {
        metadata: metadata("Inline", {
          resultBudget: { strategy: "inline", maxModelChars: 3 },
        }),
      }),
      {},
      context(),
    );

    expect(result).toMatchObject({
      success: true,
      modelContent: "abcdef",
      truncated: false,
    });
  });

  it("fails explicitly when a tool asks for the unimplemented artifact budget", async () => {
    const result = await executeToolCall(
      testTool(async () => "abcdef", {
        metadata: metadata("Artifact", {
          resultBudget: { strategy: "artifact", maxModelChars: 10 },
        }),
      }),
      {},
      context(),
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: "unsupported-budget" },
    });
  });
});

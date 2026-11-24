import type { AgentStreamEvent } from "@answra/shared/schema";
import type { TextStreamPart, ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentModelRequest } from "../../../src/core/agent/definition";
import {
  ProviderStepRunner,
  type ProviderStepRunnerOptions,
} from "../../../src/core/agent/providerStepRunner";
import type { StepContextManager } from "../../../src/core/context/stepContextManager";
import type {
  StepEventRecorder,
  StepRunContext,
  StepStart,
} from "../../../src/core/session/contracts";
import { SessionStepExecutor } from "../../../src/core/session/stepExecutor";
import {
  TEST_SESSION_ID,
  TEST_STEP_ID,
  TEST_TURN_ID,
  TEST_TURN_RUNTIME,
  userMessage,
} from "../session/fixtures";

const MODEL_REQUEST: AgentModelRequest = {
  system: "base",
  messages: [{ role: "user", content: "hello" }],
};

function stepStart(): StepStart {
  return {
    sessionId: TEST_SESSION_ID,
    turnId: TEST_TURN_ID,
    stepId: TEST_STEP_ID,
    index: 0,
    agentId: "general",
    source: "user",
    messageId: "assistant-1",
    input: userMessage(),
  };
}

function eventSink(): { context: StepRunContext; events: AgentStreamEvent[] } {
  const events: AgentStreamEvent[] = [];
  return {
    events,
    context: {
      events: {
        append: async (event) => {
          events.push(event);
        },
        flush: async () => undefined,
      },
      runtime: TEST_TURN_RUNTIME,
    },
  };
}

function partsStream(parts: readonly unknown[]): AsyncIterable<TextStreamPart<ToolSet>> {
  return (async function* () {
    for (const part of parts) yield part as TextStreamPart<ToolSet>;
  })();
}

function scriptedStream(scripts: unknown[][]): {
  stream: ProviderStepRunnerOptions["stream"];
  options: Array<Record<string, unknown>>;
} {
  const options: Array<Record<string, unknown>> = [];
  let index = 0;
  const stream = (({ options: requestOptions }) => {
    options.push(requestOptions as Record<string, unknown>);
    const parts = scripts[index] ?? [];
    index += 1;
    return partsStream(parts);
  }) as ProviderStepRunnerOptions["stream"];
  return { stream, options };
}

function completedParts(text: string): unknown[] {
  return [
    { type: "start" },
    { type: "start-step", warnings: [] },
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", text },
    { type: "text-end", id: "text-1" },
    { type: "finish-step", finishReason: "stop", usage: { inputTokens: 12, outputTokens: 3 } },
    { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 12, outputTokens: 3 } },
  ];
}

function createRunner(overrides: Partial<ProviderStepRunnerOptions> = {}): ProviderStepRunner {
  return new ProviderStepRunner({
    endpoint: { baseUrl: "http://127.0.0.1:1234/v1", model: "test.chat" },
    prepare: async () => MODEL_REQUEST,
    ...overrides,
  });
}

/** 模拟一次 session step 内部的多轮 AI SDK 请求，逐轮回调 `onStepFinish`。 */
function multiRequestStream(usages: readonly number[]): ProviderStepRunnerOptions["stream"] {
  return (({ options }) =>
    (async function* () {
      const onStepFinish = options.onStepFinish as
        | ((event: { usage: { inputTokens: number; outputTokens: number } }) => void)
        | undefined;
      for (const inputTokens of usages) {
        yield { type: "start-step", warnings: [] } as unknown as TextStreamPart<ToolSet>;
        onStepFinish?.({ usage: { inputTokens, outputTokens: 1 } });
        yield {
          type: "finish-step",
          finishReason: "tool-calls",
          usage: { inputTokens, outputTokens: 1 },
        } as unknown as TextStreamPart<ToolSet>;
      }
      yield {
        type: "finish",
        finishReason: "stop",
        totalUsage: {
          inputTokens: usages.reduce((total, value) => total + value, 0),
          outputTokens: usages.length,
        },
      } as unknown as TextStreamPart<ToolSet>;
    })()) as ProviderStepRunnerOptions["stream"];
}

describe("ProviderStepRunner", () => {
  it("prepares context, streams model events and returns finish facts", async () => {
    const { context, events } = eventSink();
    const { stream, options } = scriptedStream([completedParts("hello")]);
    const prepare = vi.fn(async () => MODEL_REQUEST);
    const contextManager: StepContextManager = {
      prepare: vi.fn(async (input) => ({ ...input.modelRequest, system: "with-context" })),
      recover: vi.fn(async () => undefined),
    };

    const result = await createRunner({
      prepare,
      contextManager,
      stream,
    }).run(stepStart(), context, new AbortController().signal);

    expect(result).toMatchObject({
      outcome: "completed",
      finishReason: "stop",
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
    });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "assistant-1", input: expect.any(Object) }),
      expect.any(AbortSignal),
      { toolOutput: expect.any(Function) },
    );
    expect(contextManager.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ modelRequest: MODEL_REQUEST }),
    );
    expect(options[0]).toMatchObject({ system: "with-context" });
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
  });

  it("reports the first and last request input while keeping the summed usage", async () => {
    const { context } = eventSink();
    const runner = createRunner({ stream: multiRequestStream([26_000, 40_000, 65_172]) });

    const result = await runner.run(stepStart(), context, new AbortController().signal);

    expect(result.requestTokens).toEqual({ firstInputTokens: 26_000, lastInputTokens: 65_172 });
    expect(result.usage?.inputTokens).toBe(131_172);
  });

  it("returns a handoff only for a non-tool-call terminal answer", async () => {
    const { context } = eventSink();
    const resolveHandoff = vi.fn(async () => ({
      toAgentId: "intake",
      task: "整理简历",
    }));
    const { stream } = scriptedStream([completedParts("done")]);
    const runner = createRunner({ resolveHandoff, stream });

    await expect(
      runner.run(stepStart(), context, new AbortController().signal),
    ).resolves.toMatchObject({
      outcome: "completed",
      finishReason: "stop",
      handoff: { toAgentId: "intake", task: "整理简历" },
    });
    expect(resolveHandoff).toHaveBeenCalledOnce();

    const toolCall = scriptedStream([
      [
        { type: "start-step", warnings: [] },
        { type: "finish-step", finishReason: "tool-calls", usage: {} },
        { type: "finish", finishReason: "tool-calls", totalUsage: {} },
      ],
    ]);
    const toolRunner = createRunner({ resolveHandoff, stream: toolCall.stream });
    const toolResult = await toolRunner.run(stepStart(), context, new AbortController().signal);

    expect(toolResult).toMatchObject({ outcome: "completed", finishReason: "tool-calls" });
    expect(toolResult.handoff).toBeUndefined();
    expect(resolveHandoff).toHaveBeenCalledOnce();
  });

  it("recovers one context overflow before producing content", async () => {
    const { context, events } = eventSink();
    const { stream, options } = scriptedStream([
      [{ type: "error", error: new Error("maximum context length exceeded") }],
      completedParts("recovered"),
    ]);
    const contextManager: StepContextManager = {
      prepare: vi.fn(async (input) => input.modelRequest),
      recover: vi.fn(async () => ({ ...MODEL_REQUEST, system: "recovered" })),
    };

    const result = await createRunner({ contextManager, stream }).run(
      stepStart(),
      context,
      new AbortController().signal,
    );

    expect(result).toMatchObject({ outcome: "completed", finishReason: "stop" });
    expect(contextManager.recover).toHaveBeenCalledOnce();
    expect(options.map((request) => request.system)).toEqual(["base", "recovered"]);
    expect(events.some((event) => event.type === "text-delta")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("uses the turn runtime access token for the provider request", async () => {
    const { context } = eventSink();
    let capturedToken: string | undefined;
    const stream: NonNullable<ProviderStepRunnerOptions["stream"]> = ({ transport }) => {
      capturedToken = transport.accessToken;
      return partsStream(completedParts("done"));
    };
    const runtime = { getAccessToken: async () => "turn-token" };

    await createRunner({ stream }).run(
      stepStart(),
      { ...context, runtime },
      new AbortController().signal,
    );

    expect(capturedToken).toBe("turn-token");
  });

  it("keeps Session step ownership separate from provider step framing", async () => {
    const events: AgentStreamEvent[] = [];
    const recorder: StepEventRecorder = {
      async append(_step, event) {
        events.push(event);
      },
    };
    const { stream } = scriptedStream([completedParts("hello")]);
    const executor = new SessionStepExecutor({
      recorder,
      runner: createRunner({ stream }),
    });

    await executor.run(stepStart(), TEST_TURN_RUNTIME, new AbortController().signal);

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
  });

  it("does not start a provider request after cancellation", async () => {
    const { context, events } = eventSink();
    const prepare = vi.fn(async () => MODEL_REQUEST);
    const { stream } = scriptedStream([]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      createRunner({ prepare, stream }).run(stepStart(), context, controller.signal),
    ).resolves.toEqual({ outcome: "aborted" });
    expect(prepare).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});

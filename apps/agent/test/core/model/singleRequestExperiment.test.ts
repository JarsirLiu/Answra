import { streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};

function modelWithToolThenText() {
  return new MockLanguageModelV3({
    doStream: [
      {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "lookup",
              input: JSON.stringify({ query: "answer" }),
            });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool_calls" },
              usage,
            });
            controller.close();
          },
        }),
      },
      {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "text-1" });
            controller.enqueue({ type: "text-delta", id: "text-1", delta: "done" });
            controller.enqueue({ type: "text-end", id: "text-1" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage,
            });
            controller.close();
          },
        }),
      },
    ],
  });
}

const lookup = tool({
  description: "Lookup a value",
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }) => `found:${query}`,
});

describe("AI SDK single-request experiment", () => {
  it("executes a supplied local tool and requests the model again in the same streamText call", async () => {
    const model = modelWithToolThenText();
    const result = streamText({
      model,
      prompt: "look it up",
      tools: { lookup },
      stopWhen: ({ steps }) => steps.length >= 3,
    });
    const parts = await collect(result.fullStream);

    expect(parts.some((part) => part.type === "tool-result")).toBe(true);
    expect(model.doStreamCalls).toHaveLength(2);
  });

  it("returns a tool call after one request when no local executor is supplied", async () => {
    const model = modelWithToolThenText();
    const result = streamText({
      model,
      prompt: "look it up",
      tools: {
        lookup: { description: "Lookup a value", inputSchema: z.object({ query: z.string() }) },
      },
    });
    const parts = await collect(result.fullStream);

    expect(parts.some((part) => part.type === "tool-call")).toBe(true);
    expect(model.doStreamCalls).toHaveLength(1);
    const steps = await result.steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]?.response.messages).toMatchObject([
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "lookup" }],
      },
    ]);

    const responseMessages = await result.response;
    const next = streamText({
      model,
      messages: [
        ...responseMessages.messages,
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "lookup",
              output: { type: "text", value: "found:answer" },
            },
          ],
        },
      ],
      tools: {
        lookup: { description: "Lookup a value", inputSchema: z.object({ query: z.string() }) },
      },
    });
    await collect(next.fullStream);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(model.doStreamCalls[1]?.prompt).toMatchObject([
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "lookup" }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call-1", toolName: "lookup" }],
      },
    ]);
  });
});

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

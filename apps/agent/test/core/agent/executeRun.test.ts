import { createServer, type Server } from "node:http";
import type { ConversationCapabilityEndpoint } from "@answra/shared";
import type { AgentEventEnvelope } from "@answra/shared/schema";
import { describe, expect, it, vi } from "vitest";
import {
  type AgentDefinition,
  type AgentRunRequest,
  agentId,
} from "../../../src/core/agent/definition";
import { executeRun, prepareModelRequest, runOutcome } from "../../../src/core/agent/executeRun";
import type { RunMetrics } from "../../../src/core/agent/streamJournal";
import { MemoryExecutionStore } from "../../../src/execution/memoryStore";

const completedMetrics: RunMetrics = {
  chunkCounts: {},
  textLength: 1,
  reasoningLength: 0,
  started: true,
  failed: false,
  finished: true,
  aborted: false,
};

describe("agent run outcome", () => {
  it("fails a run that ends while the model still wants tools", () => {
    expect(runOutcome(false, completedMetrics, "tool-calls")).toBe("failed");
  });

  it("completes a run that yields to queued input after a tool step", () => {
    expect(runOutcome(false, completedMetrics, "tool-calls", true)).toBe("completed");
  });

  it("completes a run with a terminal text answer", () => {
    expect(runOutcome(false, completedMetrics, "stop")).toBe("completed");
  });

  it("keeps cancellation and missing terminal facts explicit", () => {
    expect(runOutcome(true, completedMetrics, "stop")).toBe("aborted");
    expect(runOutcome(false, { ...completedMetrics, finished: false }, "stop")).toBe("failed");
  });

  it("passes the run abort signal to context preparation", async () => {
    const signal = new AbortController().signal;
    const modelRequest = { system: "system", messages: [] };
    const prepare = vi.fn(async () => modelRequest);
    const prepareContext = vi.fn(async (request) => request);
    const definition = { prepare } as unknown as AgentDefinition<undefined>;
    const request = { prepareContext } as unknown as AgentRunRequest<undefined, undefined>;

    await prepareModelRequest({
      definition,
      request,
      input: undefined,
      signal,
      emitter: { toolOutput: () => undefined },
    });

    expect(prepareContext).toHaveBeenCalledWith(modelRequest, expect.any(Function), signal);
  });
});

function streamBody(text: string): string {
  return [
    `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "text.chat", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "text.chat", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

type RecordedRequest = {
  messages: Array<{ role: string; content: unknown }>;
  body: Record<string, unknown>;
};

async function startModelServer(
  respond: (attempt: number) => { status: number; body: string },
): Promise<{
  server: Server;
  endpoint: ConversationCapabilityEndpoint;
  requests: RecordedRequest[];
}> {
  const requests: RecordedRequest[] = [];
  let attempt = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      messages?: Array<{ role: string; content: unknown }>;
    };
    requests.push({ messages: parsed.messages ?? [], body: parsed as Record<string, unknown> });
    attempt += 1;
    const result = respond(attempt);
    response.writeHead(result.status, {
      "content-type": result.status === 200 ? "text/event-stream" : "application/json",
    });
    response.end(result.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return {
    server,
    endpoint: { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "text.chat" },
    requests,
  };
}

function recoveryDefinition(): AgentDefinition<undefined> {
  return {
    id: agentId("recovery-agent"),
    identity: {
      name: "Recovery test",
      role: "recovery",
      responsibility: "Verify provider overflow recovery.",
      owns: ["recovery"],
    },
    discovery: { visibleTo: { kind: "team", teamId: "test" } },
    modelRoute: "chat",
    prepare: async () => ({
      system: "first prompt",
      messages: [{ role: "user" as const, content: "hello" }],
    }),
  };
}

function recoveryRequest({
  events,
  recoverContext,
}: {
  events: AgentEventEnvelope[];
  recoverContext: AgentRunRequest<undefined, undefined>["recoverContext"];
}): AgentRunRequest<undefined, undefined> {
  return {
    conversationId: "recovery-conversation",
    getAccessToken: async () => "token",
    prepareRun: async () => ({ input: undefined, prepared: undefined }),
    recoverContext,
    onEvent: async (event) => {
      events.push(event);
    },
  };
}

function plainRequest(events: AgentEventEnvelope[]): AgentRunRequest<undefined, undefined> {
  return {
    conversationId: "provider-options-conversation",
    getAccessToken: async () => "token",
    prepareRun: async () => ({ input: undefined, prepared: undefined }),
    onEvent: async (event) => {
      events.push(event);
    },
  };
}

describe("agent run context overflow recovery", () => {
  it("compacts once, retries the same run, and discards the failed attempt lifecycle", async () => {
    const { server, endpoint, requests } = await startModelServer((attempt) =>
      attempt === 1
        ? {
            status: 413,
            body: JSON.stringify({ error: { message: "maximum context length exceeded" } }),
          }
        : { status: 200, body: streamBody("recovered") },
    );
    const events: AgentEventEnvelope[] = [];
    const recoverContext = vi.fn(async () => ({
      system: "compressed prompt",
      messages: [{ role: "user" as const, content: "hello" }],
    }));

    try {
      const outcome = await executeRun({
        definition: recoveryDefinition(),
        request: recoveryRequest({ events, recoverContext }),
        input: undefined,
        runId: "run-recover-once",
        endpoint,
        executionStore: new MemoryExecutionStore(),
        controller: new AbortController(),
      });

      expect(outcome).toBe("completed");
      expect(recoverContext).toHaveBeenCalledTimes(1);
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[0]?.messages)).toContain("first prompt");
      expect(JSON.stringify(requests[1]?.messages)).toContain("compressed prompt");
      const streamed = events.map((envelope) => envelope.event.type);
      expect(streamed.filter((type) => type === "start")).toHaveLength(1);
      expect(streamed.filter((type) => type === "step-started")).toHaveLength(1);
      expect(streamed).not.toContain("error");
      expect(events.some((envelope) => envelope.event.type === "text-delta")).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not recover a second overflow in the same run", async () => {
    const { server, endpoint, requests } = await startModelServer(() => ({
      status: 413,
      body: JSON.stringify({ error: { message: "maximum context length exceeded" } }),
    }));
    const events: AgentEventEnvelope[] = [];
    const recoverContext = vi.fn(async () => ({
      system: "compressed prompt",
      messages: [{ role: "user" as const, content: "hello" }],
    }));

    try {
      const outcome = await executeRun({
        definition: recoveryDefinition(),
        request: recoveryRequest({ events, recoverContext }),
        input: undefined,
        runId: "run-recover-twice",
        endpoint,
        executionStore: new MemoryExecutionStore(),
        controller: new AbortController(),
      });

      expect(outcome).toBe("failed");
      expect(recoverContext).toHaveBeenCalledTimes(1);
      expect(requests).toHaveLength(2);
      const errors = events.filter((envelope) => envelope.event.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]?.event.type === "error" ? errors[0].event.errorText : "").toContain(
        "maximum context length exceeded",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps the original overflow terminal when compaction declines recovery", async () => {
    const { server, endpoint, requests } = await startModelServer(() => ({
      status: 413,
      body: JSON.stringify({ error: { message: "maximum context length exceeded" } }),
    }));
    const events: AgentEventEnvelope[] = [];
    const recoverContext = vi.fn(async () => undefined);

    try {
      const outcome = await executeRun({
        definition: recoveryDefinition(),
        request: recoveryRequest({ events, recoverContext }),
        input: undefined,
        runId: "run-recover-declined",
        endpoint,
        executionStore: new MemoryExecutionStore(),
        controller: new AbortController(),
      });

      expect(outcome).toBe("failed");
      expect(recoverContext).toHaveBeenCalledTimes(1);
      expect(requests).toHaveLength(1);
      expect(events.filter((envelope) => envelope.event.type === "error")).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("agent endpoint provider options", () => {
  it("writes endpoint providerOptions into the request body under the provider name", async () => {
    const { server, endpoint, requests } = await startModelServer(() => ({
      status: 200,
      body: streamBody("answer"),
    }));
    const events: AgentEventEnvelope[] = [];

    try {
      const outcome = await executeRun({
        definition: recoveryDefinition(),
        request: plainRequest(events),
        input: undefined,
        runId: "run-provider-options",
        endpoint: {
          ...endpoint,
          providerOptions: { thinking: { type: "enabled" }, max_completion_tokens: 4_096 },
        },
        executionStore: new MemoryExecutionStore(),
        controller: new AbortController(),
      });

      expect(outcome).toBe("completed");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.body).toMatchObject({
        thinking: { type: "enabled" },
        max_completion_tokens: 4_096,
      });
      expect(requests[0]?.body).not.toHaveProperty("max_tokens");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

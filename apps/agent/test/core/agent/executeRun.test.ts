import { describe, expect, it, vi } from "vitest";
import type { AgentDefinition, AgentRunRequest } from "../../../src/core/agent/definition";
import { prepareModelRequest, runOutcome } from "../../../src/core/agent/executeRun";
import type { RunMetrics } from "../../../src/core/agent/streamJournal";

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

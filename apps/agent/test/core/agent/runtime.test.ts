import type { AgentEventEnvelope } from "@answra/shared/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentDefinition, agentId } from "../../../src/core/agent/definition";
import { AgentRuntime } from "../../../src/core/agent/runtime";
import { MemoryExecutionStore } from "../../../src/execution/memoryStore";

describe("AgentRuntime static registration", () => {
  let runtime: AgentRuntime | undefined;

  afterEach(() => runtime?.dispose());

  it("rejects duplicate and unknown Agent IDs", () => {
    runtime = new AgentRuntime({
      executionStore: new MemoryExecutionStore(),
      emitEvent: () => undefined,
    });
    const definition = createFailingDefinition("test.agent");

    runtime.registerAgent(definition);
    expect(() => runtime?.registerAgent(definition)).toThrow("Agent 已注册：test.agent");
    expect(() => runtime?.requireAgent(agentId("missing.agent"))).toThrow(
      "Agent 未注册：missing.agent",
    );
  });

  it("waits for the domain event callback and publishes the run cursor before its first event", async () => {
    const observed: string[] = [];
    const emitted: AgentEventEnvelope[] = [];
    runtime = new AgentRuntime({
      executionStore: new MemoryExecutionStore(),
      emitEvent: (event) => emitted.push(event),
    });
    runtime.configureModelRoutes({
      chat: { baseUrl: "http://localhost:1234/v1", model: "chat" },
      answer: { baseUrl: "http://localhost:1234/v1", model: "answer" },
    });
    const executor = runtime.registerAgent(createFailingDefinition("test.agent"));
    let releaseFirstEvent!: () => void;
    let signalFirstEvent!: () => void;
    const firstEventReached = new Promise<void>((resolve) => {
      signalFirstEvent = resolve;
    });
    const firstEventGate = new Promise<void>((resolve) => {
      releaseFirstEvent = resolve;
    });

    const handle = await executor.startRun({
      conversationId: "conversation-1",
      getAccessToken: async () => "access-token",
      prepareRun: async ({ runId, eventRevision }) => {
        observed.push(`prepared:${eventRevision}`);
        return { input: { prompt: "hello" }, prepared: { runId } };
      },
      onEvent: async (event) => {
        observed.push(`domain:${event.event.type}`);
        if (event.event.type === "run-state-changed" && event.event.state === "queued") {
          signalFirstEvent();
          await firstEventGate;
        }
      },
    });

    await firstEventReached;
    expect(observed[0]).toBe("prepared:0");
    expect(emitted[0]?.event).toMatchObject({ type: "run-state-changed", state: "queued" });
    let settled = false;
    void handle.done.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseFirstEvent();
    await expect(handle.done).resolves.toBe("failed");
    expect(observed).toEqual([
      "prepared:0",
      "domain:run-state-changed",
      "domain:run-state-changed",
      "domain:start",
      "domain:error",
      "domain:run-state-changed",
    ]);
    expect(emitted.map((event) => event.aggregateRevision)).toEqual([1, 2, 3, 4, 5]);
    expect(await runtime.waitForRun(handle.runId)).toBeUndefined();
    expect(runtime.activeRunCount).toBe(0);
  });
});

function createFailingDefinition(id: string): AgentDefinition<{ prompt: string }> {
  return {
    id: agentId(id),
    modelRoute: "chat",
    prepare: vi.fn(async () => {
      throw new Error("prepare failed");
    }),
  };
}

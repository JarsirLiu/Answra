import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentDefinition, agentId } from "../../../src/core/agent/definition";
import { AgentRuntime } from "../../../src/core/agent/runtime";

describe("AgentRuntime static registration", () => {
  let runtime: AgentRuntime | undefined;

  afterEach(() => runtime?.dispose());

  it("rejects duplicate and unknown Agent IDs", () => {
    runtime = new AgentRuntime();
    const definition = createFailingDefinition("test.agent");

    runtime.registerAgent(definition);
    expect(() => runtime?.registerAgent(definition)).toThrow("Agent 已注册：test.agent");
    expect(() => runtime?.assertRegistered([agentId("missing.agent")])).toThrow(
      "Agent 未注册：missing.agent",
    );
  });

  it("exposes the configured chat context window", () => {
    runtime = new AgentRuntime();
    runtime.configureModelRoutes({
      chat: { baseUrl: "http://localhost:1234/v1", model: "chat", contextWindow: 128_000 },
      answer: { baseUrl: "http://localhost:1234/v1", model: "answer" },
    });

    expect(runtime.chatContextWindow()).toBe(128_000);
  });

  it("exposes static result resolution without starting a run", async () => {
    runtime = new AgentRuntime();
    const definition: AgentDefinition<{ prompt: string }> = {
      ...createFailingDefinition("test.agent"),
      prepare: async () => ({ system: "", messages: [] }),
      result: async (input) => ({
        kind: "handoff",
        to: agentId("target.agent"),
        task: input.prompt,
      }),
    };
    const executor = runtime.registerAgent(definition);

    await expect(executor.result?.({ prompt: "请继续" }, "step-1")).resolves.toEqual({
      kind: "handoff",
      to: "target.agent",
      task: "请继续",
    });
  });
});

function createFailingDefinition(id: string): AgentDefinition<{ prompt: string }> {
  return {
    id: agentId(id),
    identity: {
      name: "测试 Agent",
      role: "test",
      responsibility: "测试用 Agent。",
      owns: [],
    },
    discovery: { visibleTo: { kind: "bots", agentIds: [] } },
    modelRoute: "chat",
    prepare: vi.fn(async () => {
      throw new Error("prepare failed");
    }),
  };
}

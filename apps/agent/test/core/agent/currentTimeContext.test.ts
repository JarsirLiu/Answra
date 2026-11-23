import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withCurrentTimeContext } from "../../../src/core/agent/currentTimeContext";
import { type AgentDefinition, agentId } from "../../../src/core/agent/definition";
import { AgentRuntime } from "../../../src/core/agent/runtime";

describe("agent current time context", () => {
  let runtime: AgentRuntime | undefined;

  afterEach(() => {
    runtime?.dispose();
    runtime = undefined;
    vi.useRealTimers();
  });

  it("appends and recomputes the current time for each prepare", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T06:32:00.000Z"));
    const agent = withCurrentTimeContext(createDefinition("test.agent"));
    const signal = new AbortController().signal;

    const first = await agent.prepare({ prompt: "hello" }, signal);
    vi.setSystemTime(new Date("2026-11-10T07:32:00.000Z"));
    const second = await agent.prepare({ prompt: "hello" }, signal);

    expect(JSON.stringify(first.messages)).toContain("Current UTC time: 2026-11-10T06:32:00.000Z");
    expect(JSON.stringify(second.messages)).toContain("Current UTC time: 2026-11-10T07:32:00.000Z");
    expect(JSON.stringify(second.messages)).not.toContain(
      "Current UTC time: 2026-11-10T06:32:00.000Z",
    );
  });

  it("injects through the runtime boundary by default and honors an explicit opt-out", async () => {
    runtime = new AgentRuntime();
    const injected = runtime.registerAgent(createDefinition("test.injected"));
    const skipped = runtime.registerAgent({
      ...createDefinition("test.skipped"),
      currentTimeContext: false,
    });
    const signal = new AbortController().signal;

    const injectedRequest = await injected.prepare({ prompt: "hello" }, signal);
    const skippedRequest = await skipped.prepare({ prompt: "hello" }, signal);

    expect(JSON.stringify(injectedRequest.messages)).toContain("# currentTime");
    expect(JSON.stringify(skippedRequest.messages)).not.toContain("# currentTime");
  });
});

function createDefinition(id: string): AgentDefinition<{ prompt: string }> {
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
    async prepare() {
      const messages: ModelMessage[] = [{ role: "user", content: "hello" }];
      return { system: "测试 system", messages };
    },
  };
}

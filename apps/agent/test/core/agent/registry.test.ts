import { describe, expect, it } from "vitest";
import { agentId } from "../../../src/core/agent/definition";
import { AgentRegistry } from "../../../src/core/agent/registry";

describe("AgentRegistry", () => {
  it("rejects duplicate Agent IDs", () => {
    const registry = new AgentRegistry();
    registry.register(agentId("a"));
    expect(() => registry.register(agentId("a"))).toThrow("Agent 已注册：a");
  });

  it("requires every team entry and member to be registered", () => {
    const registry = new AgentRegistry();
    registry.register(agentId("a"));
    registry.register(agentId("b"));

    expect(() =>
      registry.assertTeamMembers(agentId("a"), [agentId("a"), agentId("b")]),
    ).not.toThrow();
    expect(() => registry.assertTeamMembers(agentId("a"), [agentId("missing")])).toThrow(
      "Agent 未注册：missing",
    );
    expect(() => registry.assertTeamMembers(agentId("missing"), [agentId("a")])).toThrow(
      "Agent 未注册：missing",
    );
  });
});

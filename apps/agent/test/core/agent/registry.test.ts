import { describe, expect, it } from "vitest";
import { agentId, type BotDiscovery, type BotIdentity } from "../../../src/core/agent/definition";
import { AgentRegistry } from "../../../src/core/agent/registry";

const identity: BotIdentity = {
  name: "测试 Bot",
  role: "test",
  responsibility: "测试",
  owns: ["test"],
};

function discovery(teamId: string): BotDiscovery {
  return { visibleTo: { kind: "team", teamId } };
}

describe("AgentRegistry", () => {
  it("rejects duplicate Agent IDs", () => {
    const registry = new AgentRegistry();
    registry.register(agentId("a"), identity, discovery("team"));
    expect(() => registry.register(agentId("a"), identity, discovery("team"))).toThrow(
      "Agent 已注册：a",
    );
  });

  it("requires every team entry and member to be registered", () => {
    const registry = new AgentRegistry();
    registry.register(agentId("a"), identity, discovery("team"));
    registry.register(agentId("b"), identity, discovery("team"));

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

  it("rejects unknown team and Bot discovery references", () => {
    const registry = new AgentRegistry();
    registry.register(agentId("a"), identity, discovery("team"));

    expect(() => registry.assertDiscoveryReferences(new Set(["team"]))).not.toThrow();
    expect(() => registry.assertDiscoveryReferences(new Set(["other"]))).toThrow(
      "Agent a 的可见团队未注册：team",
    );

    const botRegistry = new AgentRegistry();
    botRegistry.register(agentId("a"), identity, { visibleTo: { kind: "bots", agentIds: [] } });
    botRegistry.register(agentId("b"), identity, {
      visibleTo: { kind: "bots", agentIds: [agentId("missing")] },
    });
    expect(() => botRegistry.assertDiscoveryReferences(new Set())).toThrow(
      "Agent b 的发现目标未注册：missing",
    );
  });
});

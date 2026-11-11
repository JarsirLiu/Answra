import { describe, expect, it } from "vitest";
import { agentId, type BotDiscovery, type BotIdentity } from "../../../src/core/agent/definition";
import {
  assertCanHandoff,
  assertTeamDefinition,
  visibleMembers,
} from "../../../src/core/team/directory";
import type { TeamCatalog, TeamDefinition } from "../../../src/core/team/types";

const identity: BotIdentity = {
  name: "测试 Bot",
  role: "test",
  responsibility: "测试",
  owns: ["test"],
};

function bot(discovery: BotDiscovery) {
  return { identity, discovery };
}

function catalog(
  agents: Record<string, ReturnType<typeof bot>>,
  teams: Record<string, readonly string[]>,
): TeamCatalog {
  return {
    require(id) {
      const agent = agents[id];
      if (!agent) throw new Error(`Bot 未注册：${id}`);
      return agent;
    },
    isMember(teamId, id) {
      return teams[teamId]?.includes(id) ?? false;
    },
    hasTeam(teamId) {
      return teamId in teams;
    },
  };
}

function team(members: readonly string[]): TeamDefinition {
  return {
    teamId: "interview",
    entryAgentId: agentId(members[0] ?? "missing"),
    memberAgentIds: members.map(agentId),
  };
}

describe("core team directory", () => {
  it("returns every other member visible to the viewer's team", () => {
    const agents = {
      a: bot({ visibleTo: { kind: "team", teamId: "interview" } }),
      b: bot({ visibleTo: { kind: "team", teamId: "interview" } }),
      c: bot({ visibleTo: { kind: "team", teamId: "interview" } }),
    };
    const definition = team(["a", "b", "c"]);

    expect(
      visibleMembers(definition, agentId("a"), catalog(agents, { interview: ["a", "b", "c"] })),
    ).toEqual([
      expect.objectContaining({ agentId: "b" }),
      expect.objectContaining({ agentId: "c" }),
    ]);
  });

  it("respects explicit Bot visibility and never includes the viewer", () => {
    const agents = {
      a: bot({ visibleTo: { kind: "team", teamId: "interview" } }),
      b: bot({ visibleTo: { kind: "bots", agentIds: [agentId("a")] } }),
      c: bot({ visibleTo: { kind: "bots", agentIds: [] } }),
    };
    const definition = team(["a", "b", "c"]);
    const members = visibleMembers(
      definition,
      agentId("a"),
      catalog(agents, { interview: ["a", "b", "c"] }),
    );

    expect(members.map((member) => member.agentId)).toEqual(["b"]);
    expect(() =>
      assertCanHandoff(
        definition,
        agentId("a"),
        agentId("b"),
        catalog(agents, { interview: ["a", "b", "c"] }),
      ),
    ).not.toThrow();
    expect(() =>
      assertCanHandoff(
        definition,
        agentId("a"),
        agentId("c"),
        catalog(agents, { interview: ["a", "b", "c"] }),
      ),
    ).toThrow("Bot 无法发现交接目标：a -> c");
  });

  it("rejects invalid team definitions at startup", () => {
    const agents = {
      a: bot({ visibleTo: { kind: "team", teamId: "interview" } }),
      b: bot({ visibleTo: { kind: "team", teamId: "missing" } }),
      c: bot({ visibleTo: { kind: "bots", agentIds: [agentId("outsider")] } }),
    };
    const directory = catalog(agents, { interview: ["a", "b"] });

    expect(() => assertTeamDefinition(team(["a", "a"]), directory)).toThrow("团队成员重复：a");
    expect(() =>
      assertTeamDefinition({ ...team(["a"]), entryAgentId: agentId("missing") }, directory),
    ).toThrow("团队入口 Bot 未注册：missing");
    expect(() => assertTeamDefinition(team(["a", "b"]), directory)).toThrow(
      "发现关系引用了未注册的团队：missing",
    );
    expect(() => assertTeamDefinition(team(["a", "c"]), directory)).toThrow(
      "发现关系引用了团队之外的 Bot：outsider",
    );
    expect(() => assertTeamDefinition(team(["a", "unknown"]), directory)).toThrow(
      "Bot 未注册：unknown",
    );
  });
});

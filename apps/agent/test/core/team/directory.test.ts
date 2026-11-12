import { describe, expect, it } from "vitest";
import { agentId, type BotDiscovery, type BotIdentity } from "../../../src/core/agent/definition";
import { createBotCatalog } from "../../../src/core/bot/catalog";
import type { BotDescriptor } from "../../../src/core/bot/contracts";
import { assertCanHandoff, visibleBots } from "../../../src/core/bot/directory";
import { assertTeamPreset, createTeamPresetCatalog } from "../../../src/core/team/preset";

const identity: BotIdentity = {
  name: "测试 Bot",
  role: "test",
  responsibility: "测试",
  owns: ["test"],
};

function bot(id: string, discovery: BotDiscovery): BotDescriptor<unknown, unknown> {
  return {
    id: agentId(id),
    identity,
    discovery,
    domain: "conversation",
    executor: {
      startRun: async () => {
        throw new Error("not used");
      },
    },
    policy: {},
  };
}

function catalog(agents: readonly BotDescriptor<unknown, unknown>[]) {
  return createBotCatalog(agents);
}

function teams(members: readonly string[], teamId = "interview") {
  return createTeamPresetCatalog([
    {
      teamId,
      entryBotId: agentId(members[0] ?? "missing"),
      memberBotIds: members.map(agentId),
    },
  ]);
}

describe("core bot directory", () => {
  it("returns every other participant visible to the viewer's team", () => {
    const directory = catalog([
      bot("a", { visibleTo: { kind: "team", teamId: "interview" } }),
      bot("b", { visibleTo: { kind: "team", teamId: "interview" } }),
      bot("c", { visibleTo: { kind: "team", teamId: "interview" } }),
    ]);
    const presets = teams(["a", "b", "c"]);

    expect(
      visibleBots({
        participants: ["a", "b", "c"],
        viewer: "a",
        catalog: directory,
        teams: presets.teams(),
      }).map((member) => member.id),
    ).toEqual(["b", "c"]);
  });

  it("requires both session participation and Bot discovery", () => {
    const directory = catalog([
      bot("a", { visibleTo: { kind: "team", teamId: "interview" } }),
      bot("b", { visibleTo: { kind: "bots", agentIds: [agentId("a")] } }),
      bot("c", { visibleTo: { kind: "team", teamId: "interview" } }),
      bot("outsider", { visibleTo: { kind: "bots", agentIds: [agentId("a")] } }),
    ]);
    const presets = teams(["a", "b", "c"]);

    const visible = visibleBots({
      participants: ["a", "b", "c"],
      viewer: "a",
      catalog: directory,
      teams: presets.teams(),
    });
    expect(visible.map((member) => member.id)).toEqual(["b", "c"]);
    expect(() =>
      assertCanHandoff({
        participants: ["a", "b", "c"],
        from: agentId("a"),
        to: agentId("b"),
        catalog: directory,
        teams: presets.teams(),
      }),
    ).not.toThrow();
    expect(() =>
      assertCanHandoff({
        participants: ["a", "b", "c"],
        from: agentId("a"),
        to: agentId("outsider"),
        catalog: directory,
        teams: presets.teams(),
      }),
    ).toThrow("Bot 无法发现交接目标：a -> outsider");
  });

  it("rejects handoff in a single-participant conversation", () => {
    const directory = catalog([
      bot("a", { visibleTo: { kind: "team", teamId: "conversation" } }),
      bot("b", { visibleTo: { kind: "team", teamId: "conversation" } }),
    ]);
    const presets = teams(["a"], "conversation");

    expect(
      visibleBots({
        participants: ["a"],
        viewer: "a",
        catalog: directory,
        teams: presets.teams(),
      }),
    ).toEqual([]);
    expect(() =>
      assertCanHandoff({
        participants: ["a"],
        from: agentId("a"),
        to: agentId("b"),
        catalog: directory,
        teams: presets.teams(),
      }),
    ).toThrow("Bot 无法发现交接目标：a -> b");
  });

  it("validates team presets and discovery references at startup", () => {
    const directory = catalog([
      bot("a", { visibleTo: { kind: "team", teamId: "interview" } }),
      bot("b", { visibleTo: { kind: "team", teamId: "missing" } }),
      bot("c", { visibleTo: { kind: "bots", agentIds: [agentId("outsider")] } }),
    ]);
    const presets = teams(["a", "b"]);

    expect(() =>
      assertTeamPreset(
        {
          teamId: "interview",
          entryBotId: agentId("a"),
          memberBotIds: [agentId("a"), agentId("a")],
        },
        directory,
        presets.teams(),
      ),
    ).toThrow("团队成员重复：a");
    expect(() =>
      assertTeamPreset(
        { teamId: "interview", entryBotId: agentId("missing"), memberBotIds: [agentId("a")] },
        directory,
        presets.teams(),
      ),
    ).toThrow("团队入口 Bot 未注册：missing");
    expect(() =>
      assertTeamPreset(
        {
          teamId: "interview",
          entryBotId: agentId("a"),
          memberBotIds: [agentId("a"), agentId("b")],
        },
        directory,
        presets.teams(),
      ),
    ).toThrow("发现关系引用了未注册的团队：missing");
    expect(() =>
      assertTeamPreset(
        {
          teamId: "interview",
          entryBotId: agentId("a"),
          memberBotIds: [agentId("a"), agentId("c")],
        },
        directory,
        presets.teams(),
      ),
    ).toThrow("Bot 未注册：outsider");
    expect(() =>
      assertTeamPreset(
        {
          teamId: "interview",
          entryBotId: agentId("a"),
          memberBotIds: [agentId("a"), agentId("unknown")],
        },
        directory,
        presets.teams(),
      ),
    ).toThrow("Bot 未注册：unknown");
  });
});

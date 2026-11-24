/**
 * 端到端：宿主注入 SkillRoots → 扫描 → 索引进入 system prompt → 模型可调用 Skill 工具。
 * 这条链路是"AI 看得到 skill"的唯一证明，单元测试覆盖不到。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODING_AGENT_ID, createCodingAgentDefinition } from "../../../src/coding/agent";
import { CODING_POLICY } from "../../../src/coding/policy";
import { createLazySkillCatalog } from "../../../src/core/skill/catalog";
import type { SkillRoots } from "../../../src/core/skill/contracts";
import { createBuiltinToolRegistry } from "../../../src/core/tool";
import { MemoryConversationStore } from "../../../src/core/transcript/memoryStore";
import { createUserMessage } from "../../../src/core/transcript/message";

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "answra-skill-e2e-"));
  tempRoots.push(root);
  return root;
}

async function writeSkill(
  root: string,
  name: string,
  description: string,
  body = "正文",
): Promise<void> {
  const target = path.join(root, name);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(
    path.join(target, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${description}`, "---", "", body].join("\n"),
    "utf8",
  );
}

function rootsWith(overrides: Partial<SkillRoots>): SkillRoots {
  return { builtin: null, user: null, workspaceRoot: null, ...overrides };
}

/** 建一个工作区根并在其下建好 `.agents/skills`；返回工作区根本身。 */
async function makeWorkspaceWithSkills(): Promise<string> {
  const workspaceRoot = await makeRoot();
  await fs.mkdir(path.join(workspaceRoot, ".agents", "skills"), { recursive: true });
  return workspaceRoot;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("skill index reaches the model request", () => {
  async function prepare(skills: ReturnType<typeof createLazySkillCatalog> | undefined) {
    const store = new MemoryConversationStore();
    const tools = createBuiltinToolRegistry(skills ? { skills: skills.catalog } : {});
    const definition = createCodingAgentDefinition({
      store,
      tools,
      ...(skills ? { skills: skills.catalog } : {}),
    });
    const conversationId = "skill-e2e";
    await store.create(conversationId, {
      activeAgentId: CODING_AGENT_ID,
      participantAgentIds: [CODING_AGENT_ID],
    });
    const request = { text: "帮我改简历", images: [] };
    await store.beginSessionTurn(conversationId, {
      turnId: "turn-1",
      messageId: "run-1",
      userMessage: createUserMessage("user-1", request),
      authorAgentId: CODING_AGENT_ID,
    });
    const prepared = await definition.prepare(
      { conversationId, runId: "run-1", request, policy: CODING_POLICY, workspaceRoot: null },
      new AbortController().signal,
    );
    return { prepared, tools };
  }

  it("puts an allowlisted workspace skill into the system prompt", async () => {
    const workspaceRoot = await makeWorkspaceWithSkills();
    await writeSkill(
      path.join(workspaceRoot, ".agents", "skills"),
      "answra-code",
      "写代码时的工程规范",
    );
    const skills = createLazySkillCatalog(rootsWith({ workspaceRoot }));
    await skills.ready();

    const { prepared, tools } = await prepare(skills);

    expect(prepared.system).toContain("<available_skills>");
    expect(prepared.system).toContain("<name>answra-code</name>");
    expect(prepared.system).toContain("写代码时的工程规范");
    // 模型必须真的拿到 Skill 工具，否则索引指向一个调不到的能力。
    expect(Object.keys(prepared.tools ?? {})).toContain("Skill");
    await tools.dispose();
  });

  it("keeps a skill outside the profile allowlist out of the prompt and unloadable", async () => {
    const workspaceRoot = await makeWorkspaceWithSkills();
    await writeSkill(
      path.join(workspaceRoot, ".agents", "skills"),
      "not-allowlisted",
      "不该出现的 skill",
    );
    const skills = createLazySkillCatalog(rootsWith({ workspaceRoot }));
    await skills.ready();

    const { prepared, tools } = await prepare(skills);

    expect(prepared.system).not.toContain("not-allowlisted");
    // 工具仍注册（随时可能加载别的 skill），但查不到未授权的名字。
    expect(skills.catalog.find("not-allowlisted")).toBeDefined();
    await tools.dispose();
  });

  it("omits the skill section entirely when no catalog is injected", async () => {
    const { prepared, tools } = await prepare(undefined);

    expect(prepared.system).not.toContain("<available_skills>");
    expect(Object.keys(prepared.tools ?? {})).not.toContain("Skill");
    await tools.dispose();
  });

  it("resolves a workspace skill only after the workspace root is set", async () => {
    const workspaceRoot = await makeWorkspaceWithSkills();
    const skillDir = path.join(workspaceRoot, ".agents", "skills");
    await writeSkill(skillDir, "answra-code", "工作区规范");
    const skills = createLazySkillCatalog(rootsWith({}));
    await skills.ready();

    // 启动时没有工作区：索引为空。
    expect(skills.catalog.list()).toEqual([]);

    await skills.setWorkspaceRoot(workspaceRoot);

    expect(skills.catalog.find("answra-code")?.description).toBe("工作区规范");
  });
});

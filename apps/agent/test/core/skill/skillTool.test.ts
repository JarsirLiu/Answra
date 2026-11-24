import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanSkills } from "../../../src/core/skill/catalog";
import type { SkillRoots } from "../../../src/core/skill/contracts";
import { createBuiltinToolRegistry } from "../../../src/core/tool";
import { formatSkillOutput } from "../../../src/core/tool/builtin/skill/tool";
import { executeToolCall } from "../../../src/core/tool/executor/executeToolCall";
import { SKILL_TOOL_ID } from "../../../src/core/tool/ids";
import { SKILL_TOOL_NAME } from "../../../src/core/tool/names";

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "answra-skill-tool-"));
  tempRoots.push(root);
  return root;
}

async function writeSkill(root: string, dirName: string, body: string): Promise<void> {
  const target = path.join(root, dirName);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(
    path.join(target, "SKILL.md"),
    ["---", `name: ${dirName}`, `description: ${dirName} 的用途`, "---", "", body].join("\n"),
    "utf8",
  );
}

function rootsWith(builtin: string | null): SkillRoots {
  return { builtin, user: null, workspaceRoot: null };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("Skill tool registration", () => {
  it("is absent when no skill catalog is injected", () => {
    const registry = createBuiltinToolRegistry();

    expect(registry.list().map((entry) => entry.id)).not.toContain(SKILL_TOOL_ID);
  });

  it("is registered with the model-visible name Skill when a catalog exists", async () => {
    const root = await makeRoot();
    await writeSkill(root, "demo", "正文");
    const skills = await scanSkills(rootsWith(root));

    const registry = createBuiltinToolRegistry({ skills });

    const entry = registry.require(SKILL_TOOL_ID);
    expect(entry.metadata.name).toBe(SKILL_TOOL_NAME);
    expect(entry.metadata.readOnly).toBe(true);
    expect(entry.metadata.destructive).toBe(false);
  });
});

describe("Skill tool execution", () => {
  async function runTool(name: string, root: string) {
    const skills = await scanSkills(rootsWith(root));
    const registry = createBuiltinToolRegistry({ skills });
    return executeToolCall(
      registry.require(SKILL_TOOL_ID),
      { name },
      {
        toolCallId: "call-1",
        signal: new AbortController().signal,
        workspaceRoot: null,
        runId: "run-1",
        sessionId: "session-1",
      },
    );
  }

  it("returns the skill body plus its base directory and sibling files", async () => {
    const root = await makeRoot();
    await writeSkill(root, "with-assets", "改写流程说明");
    await fs.writeFile(path.join(root, "with-assets", "template.md"), "模板", "utf8");

    const result = await runTool("with-assets", root);

    expect(result.success).toBe(true);
    expect(result.modelContent).toContain("改写流程说明");
    expect(result.modelContent).toContain('<skill_content name="with-assets">');
    expect(result.modelContent).toContain("<file>template.md</file>");
    expect(result.modelContent).not.toContain("SKILL.md</file>");
  });

  it("fails with invalid-input and lists available names for an unknown skill", async () => {
    const root = await makeRoot();
    await writeSkill(root, "known", "正文");

    const result = await runTool("missing", root);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("invalid-input");
    expect(result.modelContent).toContain("known");
  });

  it("tells the model which roots were scanned when no skill is available", async () => {
    const root = await makeRoot();

    const result = await runTool("missing", root);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.modelContent).toContain("没有可用的 skill");
    expect(result.modelContent).toContain(`内置=${root}`);
    expect(result.modelContent).toContain("工作区=无");
  });

  it("rejects a path-shaped name instead of reading a file outside the skill root", async () => {
    const root = await makeRoot();
    const secret = path.join(await makeRoot(), "secret.txt");
    await fs.writeFile(secret, "TOP SECRET", "utf8");
    await writeSkill(root, "demo", "正文");

    const result = await runTool(`../../${path.basename(secret)}`, root);

    expect(result.success).toBe(false);
    expect(result.modelContent).not.toContain("TOP SECRET");
  });

  it("truncates an over-long body and tells the model", async () => {
    const root = await makeRoot();
    await writeSkill(root, "huge", "x".repeat(50_000));

    const result = await runTool("huge", root);

    expect(result.success).toBe(true);
    expect(result.modelContent).toContain("content truncated");
  });
});

describe("formatSkillOutput", () => {
  it("omits the file list section when the skill has no sibling files", () => {
    const formatted = formatSkillOutput({
      name: "demo",
      directory: "/skills/demo",
      files: [],
      content: "正文",
      truncated: false,
    });

    expect(formatted).not.toContain("<skill_files>");
    expect(formatted).toContain("Base directory for this skill: /skills/demo");
  });
});

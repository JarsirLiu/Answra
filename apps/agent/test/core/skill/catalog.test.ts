import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLazySkillCatalog, scanSkills } from "../../../src/core/skill/catalog";
import type { SkillRoots } from "../../../src/core/skill/contracts";

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "answra-skill-"));
  tempRoots.push(root);
  return root;
}

function skillDocument(name: string, description: string, body = "正文"): string {
  return ["---", `name: ${name}`, `description: ${description}`, "---", "", body].join("\n");
}

async function writeSkill(directory: string, dirName: string, content: string): Promise<void> {
  const target = path.join(directory, dirName);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "SKILL.md"), content, "utf8");
}

function rootsWith(overrides: Partial<SkillRoots>): SkillRoots {
  return { builtin: null, user: null, workspaceRoot: null, ...overrides };
}

/** 建一个工作区根，并在其下准备好 `.agents/skills`。 */
async function makeWorkspaceWithSkills(): Promise<{ workspaceRoot: string; skillDir: string }> {
  const workspaceRoot = await makeRoot();
  const skillDir = path.join(workspaceRoot, ".agents", "skills");
  await fs.mkdir(skillDir, { recursive: true });
  return { workspaceRoot, skillDir };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("scanSkills", () => {
  it("returns an empty catalog when no root is provided", async () => {
    const catalog = await scanSkills(rootsWith({}));

    expect(catalog.list()).toEqual([]);
    expect(catalog.find("anything")).toBeUndefined();
  });

  it("treats a missing root directory as that source having no skills", async () => {
    const user = path.join(await makeRoot(), "does-not-exist");

    const catalog = await scanSkills(rootsWith({ user }));

    expect(catalog.list()).toEqual([]);
  });

  it("reads directory skills and single-file skills from the same root", async () => {
    const root = await makeRoot();
    await writeSkill(root, "in-directory", skillDocument("in-directory", "目录形态"));
    await fs.writeFile(path.join(root, "single.md"), skillDocument("single", "单文件形态"), "utf8");

    const catalog = await scanSkills(rootsWith({ builtin: root }));

    expect(catalog.list().map((skill) => [skill.name, skill.description, skill.source])).toEqual([
      ["in-directory", "目录形态", "builtin"],
      ["single", "单文件形态", "builtin"],
    ]);
  });

  it("falls back to the file name only for files directly under the root", async () => {
    const root = await makeRoot();
    await fs.writeFile(
      path.join(root, "from-filename.md"),
      ["---", "description: 无 name", "---", "body"].join("\n"),
      "utf8",
    );
    await writeSkill(
      root,
      "nested",
      ["---", "description: 无 name 的子目录", "---", "body"].join("\n"),
    );

    const catalog = await scanSkills(rootsWith({ builtin: root }));

    // 子目录形态没有 name 就无法确定身份，只能跳过；单文件用文件名兜底。
    expect(catalog.list().map((skill) => skill.name)).toEqual(["from-filename"]);
  });

  it("skips skills without a description because the model cannot match them", async () => {
    const root = await makeRoot();
    await writeSkill(
      root,
      "no-description",
      ["---", "name: no-description", "---", "body"].join("\n"),
    );

    const warnings: string[] = [];
    const catalog = await scanSkills(rootsWith({ builtin: root }), (message) =>
      warnings.push(message),
    );

    expect(catalog.list()).toEqual([]);
    expect(warnings.join("\n")).toContain("缺少 description");
  });

  it("skips files without valid frontmatter instead of guessing", async () => {
    const root = await makeRoot();
    await writeSkill(root, "broken", "# 没有 frontmatter");

    const warnings: string[] = [];
    const catalog = await scanSkills(rootsWith({ builtin: root }), (message) =>
      warnings.push(message),
    );

    expect(catalog.list()).toEqual([]);
    expect(warnings.join("\n")).toContain("frontmatter");
  });

  it("rejects a skill name that is a path segment", async () => {
    const root = await makeRoot();
    await writeSkill(root, "traversal", skillDocument("../escape", "穿越尝试"));
    await writeSkill(root, "absolute", skillDocument("/etc/passwd", "绝对路径尝试"));

    const catalog = await scanSkills(rootsWith({ builtin: root }));

    expect(catalog.list()).toEqual([]);
  });

  it("lets a higher-precedence source override a same-named skill", async () => {
    const builtin = await makeRoot();
    const user = await makeRoot();
    const { workspaceRoot, skillDir } = await makeWorkspaceWithSkills();
    await writeSkill(builtin, "shared", skillDocument("shared", "内置"));
    await writeSkill(user, "shared", skillDocument("shared", "用户"));
    await writeSkill(skillDir, "shared", skillDocument("shared", "工作区"));

    const catalog = await scanSkills(rootsWith({ builtin, user, workspaceRoot }));

    expect(catalog.find("shared")).toMatchObject({ description: "工作区", source: "workspace" });
    expect(catalog.list()).toHaveLength(1);
  });

  it("keeps the higher-precedence source regardless of which root is scanned first", async () => {
    const builtin = await makeRoot();
    const { workspaceRoot, skillDir } = await makeWorkspaceWithSkills();
    await writeSkill(builtin, "shared", skillDocument("shared", "内置"));
    await writeSkill(skillDir, "shared", skillDocument("shared", "工作区"));

    const onlyBuiltinThenWorkspace = await scanSkills(rootsWith({ builtin, workspaceRoot }));
    expect(onlyBuiltinThenWorkspace.find("shared")?.description).toBe("工作区");
  });

  it("discovers workspace skills from a nested working directory up to the project root", async () => {
    const projectRoot = await makeRoot();
    await fs.mkdir(path.join(projectRoot, ".git"), { recursive: true });
    const nested = path.join(projectRoot, "packages", "app");
    await fs.mkdir(nested, { recursive: true });
    await writeSkill(
      path.join(projectRoot, ".agents", "skills"),
      "repo-skill",
      skillDocument("repo-skill", "仓库级"),
    );

    const catalog = await scanSkills(rootsWith({ workspaceRoot: nested }));

    expect(catalog.find("repo-skill")?.description).toBe("仓库级");
  });

  it("lets the nearest workspace directory override a same-named skill farther up", async () => {
    const projectRoot = await makeRoot();
    await fs.mkdir(path.join(projectRoot, ".git"), { recursive: true });
    const nested = path.join(projectRoot, "packages", "app");
    const nestedSkillDir = path.join(nested, ".agents", "skills");
    await fs.mkdir(nestedSkillDir, { recursive: true });
    await writeSkill(
      path.join(projectRoot, ".agents", "skills"),
      "shared",
      skillDocument("shared", "项目根"),
    );
    await writeSkill(nestedSkillDir, "shared", skillDocument("shared", "子包"));

    const catalog = await scanSkills(rootsWith({ workspaceRoot: nested }));

    expect(catalog.find("shared")?.description).toBe("子包");
  });

  it("stops at the project root instead of reading skills above it", async () => {
    const outer = await makeRoot();
    await writeSkill(
      path.join(outer, ".agents", "skills"),
      "outside",
      skillDocument("outside", "项目根之外"),
    );
    const projectRoot = path.join(outer, "project");
    await fs.mkdir(path.join(projectRoot, ".git"), { recursive: true });
    const nested = path.join(projectRoot, "src");
    await fs.mkdir(nested, { recursive: true });

    const catalog = await scanSkills(rootsWith({ workspaceRoot: nested }));

    expect(catalog.find("outside")).toBeUndefined();
  });

  it("exposes the injected roots for empty-catalog diagnostics", async () => {
    const roots = rootsWith({ builtin: await makeRoot(), workspaceRoot: await makeRoot() });

    const catalog = await scanSkills(roots);

    expect(catalog.roots()).toEqual(roots);
  });

  it("exposes the skill directory so relative references resolve", async () => {
    const root = await makeRoot();
    await writeSkill(root, "with-assets", skillDocument("with-assets", "带资源"));
    await fs.writeFile(path.join(root, "with-assets", "template.txt"), "x", "utf8");

    const catalog = await scanSkills(rootsWith({ builtin: root }));
    const skill = catalog.find("with-assets");

    expect(skill?.directory).toBe(await fs.realpath(path.join(root, "with-assets")));
  });

  it("skips a skill file that escapes the root through a symlink out of tree", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await fs.writeFile(path.join(outside, "SKILL.md"), skillDocument("escaped", "越界"), "utf8");

    const link = path.join(root, "linked");
    try {
      await fs.symlink(outside, link, "junction");
    } catch {
      // 无权限创建链接时跳过该断言，环境不支持符号链接不算失败。
      return;
    }

    const catalog = await scanSkills(rootsWith({ builtin: root }));

    expect(catalog.find("escaped")).toBeUndefined();
  });

  it("skips skill files larger than the size budget", async () => {
    const root = await makeRoot();
    const huge = skillDocument("huge", "超大", "x".repeat(600_000));
    await writeSkill(root, "huge", huge);

    const warnings: string[] = [];
    const catalog = await scanSkills(rootsWith({ builtin: root }), (message) =>
      warnings.push(message),
    );

    expect(catalog.list()).toEqual([]);
    expect(warnings.join("\n")).toContain("超过");
  });
});

describe("createLazySkillCatalog", () => {
  it("starts empty and fills in after the scan settles", async () => {
    const root = await makeRoot();
    await writeSkill(root, "later", skillDocument("later", "稍后可见"));

    const lazy = createLazySkillCatalog(rootsWith({ builtin: root }));

    // 扫描是异步的：未 ready 前必须为空，不能伪造内容。
    expect(lazy.catalog.list()).toEqual([]);
    await lazy.ready();
    expect(lazy.catalog.list().map((skill) => skill.name)).toEqual(["later"]);
  });

  it("drops scan results when disposed before the scan settles", async () => {
    const root = await makeRoot();
    await writeSkill(root, "late", skillDocument("late", "迟到"));

    const lazy = createLazySkillCatalog(rootsWith({ builtin: root }));
    lazy.dispose();
    const settled = await lazy.ready();

    expect(settled).toEqual([]);
    expect(lazy.catalog.list()).toEqual([]);
  });
});

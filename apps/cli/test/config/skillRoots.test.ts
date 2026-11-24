/** CLI 宿主 skill 根解析：源码运行也要能解析到内置 skill 包，且工作区根不再自行拼目录。 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCliSkillRoots } from "../../src/config/skillRoots";

describe("resolveCliSkillRoots", () => {
  it("passes the workspace root through without appending .agents/skills", () => {
    const roots = resolveCliSkillRoots("/workspace/demo");

    expect(roots.workspaceRoot).toBe("/workspace/demo");
  });

  it("keeps a missing workspace as null", () => {
    const roots = resolveCliSkillRoots(null);

    expect(roots.workspaceRoot).toBeNull();
  });

  it("resolves bundled skills from the @answra/skills package during source runs", async () => {
    const roots = resolveCliSkillRoots(null);

    expect(roots.builtin).not.toBeNull();
    if (roots.builtin === null) return;
    const entries = await fs.readdir(roots.builtin);
    expect(entries).toContain("resume-rewrite");
    await expect(
      fs.stat(path.join(roots.builtin, "resume-rewrite", "SKILL.md")),
    ).resolves.toBeTruthy();
  });
});

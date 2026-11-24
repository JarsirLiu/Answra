import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startCodingHost } from "../../src/coding/host";

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "answra-coding-host-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("coding host skill catalog", () => {
  it("exposes the scanned workspace skills through listSkills", async () => {
    const workspaceRoot = await makeRoot();
    const skillDir = path.join(workspaceRoot, ".agents", "skills", "demo");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      ["---", "name: demo", "description: 演示 skill", "---", "", "正文"].join("\n"),
      "utf8",
    );
    const host = startCodingHost({
      workspaceRoot,
      skillRoots: { builtin: null, user: null, workspaceRoot },
    });

    await expect(host.listSkills()).resolves.toEqual([
      {
        name: "demo",
        description: "演示 skill",
        source: "workspace",
        directory: expect.any(String),
        content: expect.stringContaining("正文"),
      },
    ]);

    host.dispose();
  });

  it("returns an empty catalog when the host was started without skill roots", async () => {
    const host = startCodingHost({});

    await expect(host.listSkills()).resolves.toEqual([]);

    host.dispose();
  });
});

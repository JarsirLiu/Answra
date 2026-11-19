import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadInstructionFiles } from "../../../src/core/instruction/catalog";
import { INSTRUCTION_FILE_MAX_BYTES } from "../../../src/core/instruction/contracts";
import { renderInstructionContext } from "../../../src/core/instruction/guidance";

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "answra-instruction-"));
  tempRoots.push(root);
  return root;
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("AGENTS.md instruction loading", () => {
  it("loads global and project-root-to-workspace files, stopping at the git root", async () => {
    const root = await makeRoot();
    const repo = path.join(root, "repo");
    const workspace = path.join(repo, "packages", "app");
    const globalFile = path.join(root, "global", "AGENTS.md");
    await fs.mkdir(path.join(repo, ".git"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "outside");
    await writeFile(globalFile, "global");
    await writeFile(path.join(repo, "AGENTS.md"), "project");
    await writeFile(path.join(repo, "packages", "AGENTS.md"), "packages");
    await writeFile(path.join(workspace, "AGENTS.md"), "app");

    const files = await loadInstructionFiles({ globalFile, workspaceRoot: workspace });

    expect(files.map((file) => file.content)).toEqual(["global", "project", "packages", "app"]);
    expect(files.map((file) => file.path)).toEqual([
      globalFile,
      path.join(repo, "AGENTS.md"),
      path.join(repo, "packages", "AGENTS.md"),
      path.join(workspace, "AGENTS.md"),
    ]);
  });

  it("does not read parent directories when no git root exists", async () => {
    const root = await makeRoot();
    const workspace = path.join(root, "workspace");
    await writeFile(path.join(root, "AGENTS.md"), "outside");
    await writeFile(path.join(workspace, "AGENTS.md"), "inside");

    const files = await loadInstructionFiles({ globalFile: null, workspaceRoot: workspace });

    expect(files.map((file) => file.content)).toEqual(["inside"]);
  });

  it("keeps an empty file and skips a missing global file", async () => {
    const root = await makeRoot();
    const workspace = path.join(root, "workspace");
    const globalFile = path.join(root, "missing", "AGENTS.md");
    await writeFile(path.join(workspace, "AGENTS.md"), "");

    const files = await loadInstructionFiles({ globalFile, workspaceRoot: workspace });

    expect(files).toEqual([{ path: path.join(workspace, "AGENTS.md"), content: "" }]);
  });

  it("deduplicates the same file without dropping its content", async () => {
    const root = await makeRoot();
    const file = path.join(root, "AGENTS.md");
    await writeFile(file, "shared");

    const files = await loadInstructionFiles({ globalFile: file, workspaceRoot: root });

    expect(files).toEqual([{ path: file, content: "shared" }]);
  });

  it("skips an oversized file and reports it as a warning", async () => {
    const root = await makeRoot();
    const file = path.join(root, "AGENTS.md");
    await writeFile(file, "x".repeat(INSTRUCTION_FILE_MAX_BYTES + 1));
    const warnings: string[] = [];

    const files = await loadInstructionFiles({
      globalFile: null,
      workspaceRoot: root,
      onWarning: (message) => warnings.push(message),
    });

    expect(files).toEqual([]);
    expect(warnings[0]).toContain("AGENTS.md 超过");
    expect(warnings[0]).toContain(file);
  });

  it("renders file paths and keeps specificity order in the prompt fragment", async () => {
    const rendered = renderInstructionContext([
      { path: "/repo/AGENTS.md", content: "project" },
      { path: "/repo/app/AGENTS.md", content: "app" },
    ]);

    expect(rendered).toContain("Instructions from: /repo/AGENTS.md\nproject");
    expect(rendered).toContain("Instructions from: /repo/app/AGENTS.md\napp");
    expect(rendered.indexOf("project")).toBeLessThan(rendered.indexOf("app"));
  });
});

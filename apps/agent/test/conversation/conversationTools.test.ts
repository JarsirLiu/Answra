import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeGrep } from "../../src/conversation/tools/grep";
import { executeRead } from "../../src/conversation/tools/read";
import {
  createAuthorizedConversationTools,
  getConversationToolDefinitions,
} from "../../src/conversation/tools/registry";

describe("conversation tool registry", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("exposes only profile-authorized definitions with their registered model names", () => {
    const definitions = getConversationToolDefinitions();
    const tools = createAuthorizedConversationTools(["conversation.read"], {
      workspaceRoot: null,
      signal: new AbortController().signal,
    });

    expect(definitions.map(({ id, name }) => [id, name])).toEqual([
      ["conversation.read", "Read"],
      ["conversation.grep", "Grep"],
    ]);
    expect(Object.keys(tools)).toEqual(["Read"]);
  });

  it("reads bounded line ranges and searches matching content inside the Agent process", async () => {
    const root = await createRoot();
    await fs.mkdir(path.join(root, "notes"));
    await fs.writeFile(
      path.join(root, "notes", "plan.md"),
      "Review\nAgent foundation\nDone",
      "utf8",
    );
    await fs.mkdir(path.join(root, ".private"));
    await fs.writeFile(path.join(root, ".private", "hidden.md"), "Agent secret", "utf8");
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const readResult = await executeRead(context, {
      file_path: "notes/plan.md",
      offset: 2,
      limit: 1,
    });
    const grepResult = await executeGrep(context, { pattern: "Agent" });

    expect(readResult).toContain("2\tAgent foundation");
    expect(grepResult).toContain("notes/plan.md:2:Agent foundation");
    expect(grepResult).not.toContain("hidden.md");
  });

  it("rejects traversal, symlink escapes, unsupported files, invalid patterns, and cancellation", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    await fs.writeFile(path.join(outside, "secret.md"), "secret", "utf8");
    await fs.symlink(outside, path.join(root, "escape"), "junction");
    await fs.writeFile(path.join(root, "document.pdf"), "pdf", "utf8");
    const controller = new AbortController();
    const context = { workspaceRoot: root, signal: controller.signal };
    await expect(executeRead(context, { file_path: "../secret.md" })).rejects.toThrow(
      "工作区内的相对",
    );
    await expect(executeRead(context, { file_path: "escape/secret.md" })).rejects.toThrow(
      "路径超出",
    );
    await expect(executeRead(context, { file_path: "document.pdf" })).rejects.toThrow("纯文本");
    await expect(executeGrep(context, { pattern: "secret" })).resolves.toContain("未找到");
    controller.abort();
    await expect(executeRead(context, { file_path: "document.pdf" })).rejects.toThrow("取消");
  });

  async function createRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "answra-agent-tools-"));
    roots.push(root);
    return root;
  }
});

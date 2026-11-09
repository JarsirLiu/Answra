import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReadFileStateMap, ToolContext } from "../../../src/core/tool";
import { executeRead } from "../../../src/core/tool/builtin/read";

function context(workspaceRoot: string | null, readFileState?: ReadFileStateMap): ToolContext {
  return {
    toolCallId: "tool-call-1",
    signal: new AbortController().signal,
    workspaceRoot,
    runId: "run-1",
    sessionId: "session-1",
    ...(readFileState ? { readFileState } : {}),
  };
}

describe("Read tool edge cases", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("clamps zero offsets and limits to the first line", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "a.txt"), "a\nb\nc", "utf8");

    await expect(
      executeRead(context(root), { file_path: "a.txt", offset: 0, limit: 0 }),
    ).resolves.toMatchObject({ type: "text", content: "a", startLine: 1, numLines: 1 });
  });

  it("suggests a near-miss filename for a missing read", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "plan.md"), "content", "utf8");

    await expect(executeRead(context(root), { file_path: "pln.md" })).rejects.toThrow(
      "是否想找 plan.md",
    );
  });

  it("omits the suggestion when no similar filename exists", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "other.txt"), "content", "utf8");

    const error = await executeRead(context(root), { file_path: "missing.md" }).catch(
      (reason: unknown) => reason,
    );
    if (!(error instanceof Error)) throw new Error("expected executeRead to reject");

    expect(error.message).toContain("文件不存在");
    expect(error.message).not.toContain("是否想找");
  });

  it("omits the suggestion when the parent directory cannot be listed", async () => {
    const root = await createRoot();

    await expect(
      executeRead(context(root), { file_path: "no-such-dir/missing.md" }),
    ).rejects.toThrow(/文件不存在/);
  });

  it("tells the model to use an absolute path when no workspace is selected", async () => {
    const root = await createRoot();
    const missing = path.join(root, "missing.md");

    await expect(executeRead(context(null), { file_path: missing })).rejects.toThrow(
      "尚未选择工作区目录",
    );
  });

  it("rejects reading a directory", async () => {
    const root = await createRoot();
    await fs.mkdir(path.join(root, "notes"));

    await expect(executeRead(context(root), { file_path: "notes" })).rejects.toMatchObject({
      code: "invalid-input",
      message: "Agent 只能读取文件",
    });
  });

  it("does not treat a partial-view read as file_unchanged", async () => {
    const root = await createRoot();
    const text = Array.from({ length: 5_000 }, () => "x".repeat(20)).join("\n");
    await fs.writeFile(path.join(root, "large.md"), text, "utf8");
    const state: ReadFileStateMap = new Map();

    const first = await executeRead(context(root, state), { file_path: "large.md" });
    const second = await executeRead(context(root, state), { file_path: "large.md" });

    expect(first).toMatchObject({ type: "text", truncatedByTokenCap: true });
    expect(second).toMatchObject({ type: "text" });
  });

  it("keys cached reads by their line range", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "a.txt"), "a\nb\nc", "utf8");
    const state: ReadFileStateMap = new Map();

    const whole = await executeRead(context(root, state), { file_path: "a.txt" });
    const firstRange = await executeRead(context(root, state), {
      file_path: "a.txt",
      offset: 1,
      limit: 1,
    });
    const secondRange = await executeRead(context(root, state), {
      file_path: "a.txt",
      offset: 2,
      limit: 1,
    });

    expect(whole).toMatchObject({ type: "text" });
    expect(firstRange).toMatchObject({ type: "text", content: "a" });
    expect(secondRange).toMatchObject({ type: "text", content: "b" });
  });

  it("maps an over-token explicit range to output-too-large", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "huge.md"), "x".repeat(100_000), "utf8");

    await expect(
      executeRead(context(root), { file_path: "huge.md", offset: 1, limit: 1 }),
    ).rejects.toMatchObject({ code: "output-too-large" });
  });

  async function createRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "answra-read-test-"));
    roots.push(root);
    return root;
  }
});

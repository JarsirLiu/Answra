import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReadFileStateMap, ToolContext } from "../../../src/core/tool";
import { editTool, executeEdit } from "../../../src/core/tool/builtin/edit";
import { executeRead } from "../../../src/core/tool/builtin/read";
import { createReadFileStateKey } from "../../../src/core/tool/builtin/readFileState";
import { formatReadOutput } from "../../../src/core/tool/builtin/readOutput";

function context(workspaceRoot: string, readFileState?: ReadFileStateMap): ToolContext {
  return {
    toolCallId: "tool-call-1",
    signal: new AbortController().signal,
    workspaceRoot,
    runId: "run-1",
    sessionId: "session-1",
    ...(readFileState ? { readFileState } : {}),
  };
}

describe("Edit tool", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("fails closed when the session has no read state", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "a.txt"), "alpha", "utf8");

    await expect(
      executeEdit(context(root), {
        file_path: "a.txt",
        old_string: "alpha",
        new_string: "beta",
      }),
    ).rejects.toThrow("没有文件读取状态");
  });

  it("requires a complete read before editing", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "a.txt"), "alpha", "utf8");
    const state: ReadFileStateMap = new Map();

    await expect(
      executeEdit(context(root, state), {
        file_path: "a.txt",
        old_string: "alpha",
        new_string: "beta",
      }),
    ).rejects.toThrow("必须先用 Read");
  });

  it("does not accept a partial-view read as the edit baseline", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "a.txt");
    await fs.writeFile(filePath, "alpha", "utf8");
    const realPath = await fs.realpath(filePath);
    const stat = await fs.stat(realPath);
    const state: ReadFileStateMap = new Map();
    state.set(createReadFileStateKey(realPath, 1, undefined), {
      path: realPath,
      mtimeMs: Math.trunc(stat.mtimeMs),
      sizeBytes: stat.size,
      offset: 1,
      limit: undefined,
      partialView: true,
      origin: "read",
    });

    await expect(
      executeEdit(context(root, state), {
        file_path: "a.txt",
        old_string: "alpha",
        new_string: "beta",
      }),
    ).rejects.toThrow("完整读取");
  });

  it("rejects an edit when the file changed after the read", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "a.txt");
    await fs.writeFile(filePath, "alpha", "utf8");
    const state: ReadFileStateMap = new Map();
    await executeRead(context(root, state), { file_path: "a.txt" });

    await fs.writeFile(filePath, "alpha changed", "utf8");

    await expect(
      executeEdit(context(root, state), {
        file_path: "a.txt",
        old_string: "alpha",
        new_string: "beta",
      }),
    ).rejects.toThrow("已被修改");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("alpha changed");
  });

  it("replaces a unique match and lets the next Read return the new content", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "a.txt");
    await fs.writeFile(filePath, "alpha\nbeta\n", "utf8");
    const state: ReadFileStateMap = new Map();
    await executeRead(context(root, state), { file_path: "a.txt" });

    const output = await executeEdit(context(root, state), {
      file_path: "a.txt",
      old_string: "beta",
      new_string: "BETA",
    });

    expect(output).toMatchObject({
      type: "edited",
      filePath: await fs.realpath(filePath),
      replacements: 1,
      replaceAll: false,
      lineEndings: "LF",
    });
    expect(output.diff.hunks).toHaveLength(1);
    expect(output.diff.hunks[0]).toMatchObject({
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
    });
    expect(output.diff.hunks[0]?.lines).toEqual([
      { kind: "context", text: "alpha" },
      { kind: "removed", text: "beta" },
      { kind: "added", text: "BETA" },
      { kind: "context", text: "" },
    ]);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("alpha\nBETA\n");
    expect([...state.values()]).toMatchObject([{ origin: "edit", partialView: false }]);

    const next = await executeRead(context(root, state), { file_path: "a.txt" });
    expect(next).toMatchObject({ type: "text", content: "alpha\nBETA\n" });
    expect(formatReadOutput(next)).toContain("2\tBETA");
  });

  it("allows consecutive edits from the edit baseline", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "a.txt");
    await fs.writeFile(filePath, "alpha", "utf8");
    const state: ReadFileStateMap = new Map();
    await executeRead(context(root, state), { file_path: "a.txt" });

    await executeEdit(context(root, state), {
      file_path: "a.txt",
      old_string: "alpha",
      new_string: "beta",
    });
    await executeEdit(context(root, state), {
      file_path: "a.txt",
      old_string: "beta",
      new_string: "gamma",
    });

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("gamma");
  });

  it("refuses ambiguous matches unless replace_all is true", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "a.txt");
    await fs.writeFile(filePath, "x\nx\n", "utf8");
    const state: ReadFileStateMap = new Map();
    await executeRead(context(root, state), { file_path: "a.txt" });

    await expect(
      executeEdit(context(root, state), {
        file_path: "a.txt",
        old_string: "x",
        new_string: "y",
      }),
    ).rejects.toThrow("出现了 2 次");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("x\nx\n");

    const output = await executeEdit(context(root, state), {
      file_path: "a.txt",
      old_string: "x",
      new_string: "y",
      replace_all: true,
    });

    expect(output).toMatchObject({ replacements: 2, replaceAll: true });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("y\ny\n");
  });

  it("returns multiple diff hunks for a replace_all edit", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "a.txt");
    await fs.writeFile(filePath, "x\n1\n2\n3\n4\n5\n6\n7\nx\n", "utf8");
    const state: ReadFileStateMap = new Map();
    await executeRead(context(root, state), { file_path: "a.txt" });

    const output = await executeEdit(context(root, state), {
      file_path: "a.txt",
      old_string: "x",
      new_string: "y",
      replace_all: true,
    });

    expect(output.replacements).toBe(2);
    expect(output.diff.hunks).toHaveLength(2);
    expect(output.diff.hunks[0]?.lines).toContainEqual({ kind: "removed", text: "x" });
    expect(output.diff.hunks[1]?.lines).toContainEqual({ kind: "added", text: "y" });
  });

  it("accepts old_string copied from Read with line-number prefixes", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "a.txt");
    await fs.writeFile(filePath, "alpha\nbeta", "utf8");
    const state: ReadFileStateMap = new Map();
    const read = await executeRead(context(root, state), { file_path: "a.txt" });

    await executeEdit(context(root, state), {
      file_path: "a.txt",
      old_string: formatReadOutput(read),
      new_string: "ALPHA\nBETA",
    });

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("ALPHA\nBETA");
  });

  it("rejects a replacement that leaves the file unchanged after prefix stripping", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "a.txt");
    await fs.writeFile(filePath, "alpha", "utf8");
    const state: ReadFileStateMap = new Map();
    await executeRead(context(root, state), { file_path: "a.txt" });

    await expect(
      executeEdit(context(root, state), {
        file_path: "a.txt",
        old_string: "1\talpha",
        new_string: "alpha",
      }),
    ).rejects.toThrow("不需要写盘");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("alpha");
  });

  it("preserves a UTF-8 BOM and CRLF line endings", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "a.txt");
    await fs.writeFile(
      filePath,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\r\nb\r\n", "utf8")]),
    );
    const state: ReadFileStateMap = new Map();
    await executeRead(context(root, state), { file_path: "a.txt" });

    await executeEdit(context(root, state), {
      file_path: "a.txt",
      old_string: "b",
      new_string: "B",
    });

    const bytes = await fs.readFile(filePath);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("utf8").slice(1)).toBe("a\r\nB\r\n");
  });

  it("invalidates every cached range after a write", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "a.txt");
    await fs.writeFile(filePath, "one\ntwo\nthree", "utf8");
    const state: ReadFileStateMap = new Map();
    const toolContext = context(root, state);
    await executeRead(toolContext, { file_path: "a.txt" });
    await executeRead(toolContext, { file_path: "a.txt", offset: 2, limit: 1 });

    await executeEdit(toolContext, {
      file_path: "a.txt",
      old_string: "two",
      new_string: "TWO",
    });

    const range = await executeRead(toolContext, {
      file_path: "a.txt",
      offset: 2,
      limit: 1,
    });
    expect(range).toMatchObject({ type: "text", content: "TWO" });
  });

  it("rejects edits inside version-control directories", async () => {
    const root = await createRoot();
    const gitDirectory = path.join(root, ".git");
    const filePath = path.join(gitDirectory, "config");
    await fs.mkdir(gitDirectory);
    await fs.writeFile(filePath, "secret", "utf8");
    const realPath = await fs.realpath(filePath);
    const stat = await fs.stat(realPath);
    const state: ReadFileStateMap = new Map();
    state.set(createReadFileStateKey(realPath, 1, undefined), {
      path: realPath,
      mtimeMs: Math.trunc(stat.mtimeMs),
      sizeBytes: stat.size,
      offset: 1,
      limit: undefined,
      partialView: false,
      origin: "read",
    });

    await expect(
      executeEdit(context(root, state), {
        file_path: ".git/config",
        old_string: "secret",
        new_string: "public",
      }),
    ).rejects.toThrow("版本库");
  });

  it("rejects files above the edit size limit", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "large.txt");
    await fs.writeFile(filePath, "x".repeat(1024 * 1024 + 1), "utf8");
    const realPath = await fs.realpath(filePath);
    const stat = await fs.stat(realPath);
    const state: ReadFileStateMap = new Map();
    state.set(createReadFileStateKey(realPath, 1, undefined), {
      path: realPath,
      mtimeMs: Math.trunc(stat.mtimeMs),
      sizeBytes: stat.size,
      offset: 1,
      limit: undefined,
      partialView: false,
      origin: "read",
    });

    await expect(
      executeEdit(context(root, state), {
        file_path: "large.txt",
        old_string: "x",
        new_string: "y",
      }),
    ).rejects.toThrow("编辑上限");
  });

  it("validates cross-field constraints before writing", () => {
    expect(
      editTool.validateInput?.({
        file_path: "a.txt",
        old_string: "same",
        new_string: "same",
      }),
    ).toMatchObject({ code: "invalid-input" });
    expect(
      editTool.validateInput?.({
        file_path: "a.txt",
        old_string: "",
        new_string: "new",
      }),
    ).toMatchObject({ code: "invalid-input" });
    expect(
      editTool.validateInput?.({
        file_path: "a.txt",
        old_string: "old",
        new_string: "new",
        replace_all: "yes",
      }),
    ).toMatchObject({ code: "invalid-input" });
  });

  async function createRoot(): Promise<string> {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "answra-edit-test-")));
    roots.push(root);
    return root;
  }
});

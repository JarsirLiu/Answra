import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../../../src/core/tool";
import { editTool, executeEdit, formatEditOutput } from "../../../src/core/tool/builtin/edit/tool";
import { formatReadOutput } from "../../../src/core/tool/builtin/read/output";
import { executeRead } from "../../../src/core/tool/builtin/read/tool";

function context(workspaceRoot: string): ToolContext {
  return {
    toolCallId: "tool-call-1",
    signal: new AbortController().signal,
    workspaceRoot,
    runId: "run-1",
    sessionId: "session-1",
  };
}

describe("Edit tool", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("creates a new file with an empty old_string without a prior Read", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "notes", "new.md");
    await fs.mkdir(path.join(root, "notes"));

    const output = await executeEdit(context(root), {
      file_path: "notes/new.md",
      old_string: "",
      new_string: "# 标题\n正文\n",
    });

    expect(output).toMatchObject({
      type: "created",
      filePath: await fs.realpath(filePath),
      replacements: 0,
      replaceAll: false,
      lineEndings: "LF",
    });
    expect(output.diff.deletions).toBe(0);
    expect(output.diff.additions).toBeGreaterThan(0);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("# 标题\n正文\n");
    expect(formatEditOutput(output)).toContain("has been created successfully");
  });

  it("creates an empty file with empty old_string and new_string", async () => {
    const root = await createRoot();

    const output = await executeEdit(context(root), {
      file_path: "empty.txt",
      old_string: "",
      new_string: "",
    });

    expect(output).toMatchObject({ type: "created", sizeBytes: 0 });
    await expect(fs.readFile(path.join(root, "empty.txt"), "utf8")).resolves.toBe("");
  });

  it("fills an existing empty file without a prior Read", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "empty.txt");
    await fs.writeFile(filePath, "", "utf8");

    const output = await executeEdit(context(root), {
      file_path: "empty.txt",
      old_string: "",
      new_string: "filled\n",
    });

    expect(output).toMatchObject({ type: "created", replacements: 0 });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("filled\n");
  });

  it("rejects creating over an existing non-empty file or editing a missing file", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "a.txt");
    await fs.writeFile(filePath, "original", "utf8");

    await expect(
      executeEdit(context(root), {
        file_path: "a.txt",
        old_string: "",
        new_string: "replacement",
      }),
    ).rejects.toThrow("文件已存在");
    await expect(
      executeEdit(context(root), {
        file_path: "missing.txt",
        old_string: "old",
        new_string: "new",
      }),
    ).rejects.toThrow("文件不存在");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("original");
  });

  it("edits an existing file without a prior Read", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "a.txt");
    await fs.writeFile(filePath, "alpha", "utf8");

    const output = await executeEdit(context(root), {
      file_path: "a.txt",
      old_string: "alpha",
      new_string: "beta",
    });

    expect(output).toMatchObject({ type: "edited", replacements: 1 });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("beta");
  });

  it("edits after a range Read", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "a.txt");
    await fs.writeFile(filePath, "alpha\nbeta\ngamma", "utf8");

    await executeRead(context(root), { file_path: "a.txt", offset: 2, limit: 1 });
    await executeEdit(context(root), {
      file_path: "a.txt",
      old_string: "beta",
      new_string: "BETA",
    });

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("alpha\nBETA\ngamma");
  });

  it("serializes concurrent edits to the same path", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "a.txt");
    await fs.writeFile(filePath, "alpha\nbeta\n", "utf8");

    const [first, second] = await Promise.all([
      executeEdit(context(root), {
        file_path: "a.txt",
        old_string: "alpha",
        new_string: "ALPHA",
      }),
      executeEdit(context(root), {
        file_path: "a.txt",
        old_string: "beta",
        new_string: "BETA",
      }),
    ]);

    expect(first).toMatchObject({ type: "edited", replacements: 1 });
    expect(second).toMatchObject({ type: "edited", replacements: 1 });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("ALPHA\nBETA\n");
  });

  it("allows consecutive edits without another Read", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "a.txt");
    await fs.writeFile(filePath, "alpha", "utf8");

    await executeEdit(context(root), {
      file_path: "a.txt",
      old_string: "alpha",
      new_string: "beta",
    });
    await executeEdit(context(root), {
      file_path: "a.txt",
      old_string: "beta",
      new_string: "gamma",
    });

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("gamma");
  });

  it("allows consecutive edits to a CRLF file", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "a.txt");
    await fs.writeFile(filePath, "a\r\nb\r\n", "utf8");

    await executeEdit(context(root), {
      file_path: "a.txt",
      old_string: "b",
      new_string: "B",
    });
    await executeEdit(context(root), {
      file_path: "a.txt",
      old_string: "B",
      new_string: "C",
    });

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("a\r\nC\r\n");
  });

  it("releases the path queue after a failed edit", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "a.txt");
    await fs.writeFile(filePath, "alpha", "utf8");

    await expect(
      executeEdit(context(root), {
        file_path: "a.txt",
        old_string: "missing",
        new_string: "beta",
      }),
    ).rejects.toThrow("旧内容未在文件中找到");

    const output = await executeEdit(context(root), {
      file_path: "a.txt",
      old_string: "alpha",
      new_string: "beta",
    });

    expect(output).toMatchObject({ type: "edited", replacements: 1 });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("beta");
  });

  it("refuses ambiguous matches unless replace_all is true", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "a.txt");
    await fs.writeFile(filePath, "x\nx\n", "utf8");

    await expect(
      executeEdit(context(root), {
        file_path: "a.txt",
        old_string: "x",
        new_string: "y",
      }),
    ).rejects.toThrow("出现了 2 次");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("x\nx\n");

    const output = await executeEdit(context(root), {
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

    const output = await executeEdit(context(root), {
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
    const read = await executeRead(context(root), { file_path: "a.txt" });

    await executeEdit(context(root), {
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

    await expect(
      executeEdit(context(root), {
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

    await executeEdit(context(root), {
      file_path: "a.txt",
      old_string: "b",
      new_string: "B",
    });

    const bytes = await fs.readFile(filePath);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("utf8").slice(1)).toBe("a\r\nB\r\n");
  });

  it("rejects edits inside version-control directories", async () => {
    const root = await createRoot();
    const gitDirectory = path.join(root, ".git");
    const filePath = path.join(gitDirectory, "config");
    await fs.mkdir(gitDirectory);
    await fs.writeFile(filePath, "secret", "utf8");

    await expect(
      executeEdit(context(root), {
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

    await expect(
      executeEdit(context(root), {
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
    ).toBeUndefined();
    expect(
      editTool.validateInput?.({
        file_path: "a.txt",
        old_string: "",
        new_string: "new",
        replace_all: true,
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

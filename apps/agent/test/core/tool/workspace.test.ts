import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNotAborted,
  readToolTextFile,
  resolveToolFile,
  resolveToolTarget,
  statToolFile,
} from "../../../src/core/tool/builtin/workspace";

describe("workspace path resolution", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("resolves a file target with its search root and guest path", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "a.txt"), "hello", "utf8");

    const target = await resolveToolTarget(root, "a.txt");

    expect(target.kind).toBe("file");
    expect(target.searchRoot).toBe(root);
    expect(target.guestPath).toBe("./a.txt");
    await expect(resolveToolFile(root, "a.txt")).resolves.toBe(path.join(root, "a.txt"));
  });

  it("resolves a directory target as the search root", async () => {
    const root = await createRoot();
    await fs.mkdir(path.join(root, "notes"));

    const target = await resolveToolTarget(root, "notes");

    expect(target).toMatchObject({ kind: "directory", searchRoot: path.join(root, "notes") });
    expect(target.guestPath).toBe(".");
  });

  it("rejects directories when a file is required", async () => {
    const root = await createRoot();
    await fs.mkdir(path.join(root, "notes"));

    await expect(resolveToolFile(root, "notes")).rejects.toMatchObject({
      name: "ToolExecutionError",
      code: "invalid-input",
      message: "Agent 只能读取文件",
    });
  });

  it("rejects empty, over-long, and drive-relative paths", async () => {
    const root = await createRoot();

    await expect(resolveToolFile(root, "")).rejects.toMatchObject({ code: "invalid-input" });
    await expect(resolveToolFile(root, "a".repeat(1_025))).rejects.toMatchObject({
      code: "invalid-input",
    });
    await expect(resolveToolFile(root, "C:relative.txt")).rejects.toMatchObject({
      code: "invalid-input",
      message: "路径不能是盘符相对形式",
    });
  });

  it("requires absolute paths when no workspace is selected", async () => {
    const root = await createRoot();
    const file = path.join(root, "a.txt");
    await fs.writeFile(file, "hello", "utf8");

    await expect(resolveToolFile(null, "a.txt")).rejects.toMatchObject({
      code: "invalid-input",
      message: "使用相对路径前请先选择工作区目录，或提供绝对路径",
    });
    await expect(resolveToolFile(null, file)).resolves.toBe(file);
  });

  it("rejects paths inside version-control directories", async () => {
    const root = await createRoot();
    await fs.mkdir(path.join(root, ".git"));
    await fs.writeFile(path.join(root, ".git", "config"), "secret", "utf8");
    await fs.mkdir(path.join(root, "notes", ".svn"), { recursive: true });
    await fs.writeFile(path.join(root, "notes", ".svn", "entries"), "secret", "utf8");

    await expect(resolveToolFile(root, ".git/config")).rejects.toMatchObject({
      code: "invalid-input",
      message: "Agent 不可访问版本库目录中的内容",
    });
    await expect(resolveToolFile(root, "notes/.svn/entries")).rejects.toMatchObject({
      code: "invalid-input",
    });
  });

  it("reports file size and modification time", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "a.txt"), "hello", "utf8");

    const stat = await statToolFile(root, "a.txt");

    expect(stat).toMatchObject({ target: path.join(root, "a.txt"), sizeBytes: 5 });
    expect(stat.mtimeMs).toBeGreaterThan(0);
  });

  it("rejects files above the read byte limit", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "a.txt"), "0123456789", "utf8");

    await expect(readToolTextFile(path.join(root, "a.txt"), 5)).rejects.toThrow("单次读取上限");
  });

  it("decodes UTF-8 and UTF-16 files with BOMs", async () => {
    const root = await createRoot();
    const utf8 = path.join(root, "utf8.txt");
    const utf16le = path.join(root, "utf16le.txt");
    const utf16be = path.join(root, "utf16be.txt");
    await fs.writeFile(utf8, Buffer.from([0xef, 0xbb, 0xbf, 0x48, 0x69]));
    await fs.writeFile(utf16le, Buffer.from("\uFEFFHello", "utf16le"));
    await fs.writeFile(utf16be, Buffer.from([0xfe, 0xff, 0x00, 0x48, 0x00, 0x69]));

    await expect(readToolTextFile(utf8, 100)).resolves.toMatchObject({ text: "Hi", bytesRead: 5 });
    await expect(readToolTextFile(utf16le, 100)).resolves.toMatchObject({ text: "Hello" });
    await expect(readToolTextFile(utf16be, 100)).resolves.toMatchObject({ text: "Hi" });
  });

  it("rejects binary and invalid UTF-8 files", async () => {
    const root = await createRoot();
    const withNull = path.join(root, "null.bin");
    const controlHeavy = path.join(root, "control.bin");
    const invalidUtf8 = path.join(root, "invalid.bin");
    await fs.writeFile(withNull, Buffer.from([0x48, 0x00, 0x69]));
    await fs.writeFile(controlHeavy, Buffer.from([0x01, 0x02, 0x03]));
    await fs.writeFile(invalidUtf8, Buffer.from([0x80, 0x81]));

    for (const file of [withNull, controlHeavy, invalidUtf8]) {
      await expect(readToolTextFile(file, 100)).rejects.toThrow("UTF-8/UTF-16");
    }
  });

  it("throws when reading with an aborted signal", () => {
    const controller = new AbortController();
    controller.abort();

    expect(() => assertNotAborted(new AbortController().signal)).not.toThrow();
    expect(() => assertNotAborted(controller.signal)).toThrow("工具调用已取消");
  });

  async function createRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "answra-workspace-test-"));
    roots.push(root);
    return root;
  }
});

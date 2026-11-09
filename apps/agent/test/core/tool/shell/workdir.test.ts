import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveShellWorkdir } from "../../../../src/core/tool/builtin/shell/workdir";

describe("resolveShellWorkdir", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("defaults to the workspace root for missing or blank input", async () => {
    const root = await createRoot();

    await expect(resolveShellWorkdir(root, undefined)).resolves.toBe(root);
    await expect(resolveShellWorkdir(root, "")).resolves.toBe(root);
    await expect(resolveShellWorkdir(root, "   ")).resolves.toBe(root);
  });

  it("resolves relative and absolute workdirs", async () => {
    const root = await createRoot();
    const nested = path.join(root, "nested");
    await fs.mkdir(nested);

    await expect(resolveShellWorkdir(root, "nested")).resolves.toBe(nested);
    await expect(resolveShellWorkdir(root, nested)).resolves.toBe(nested);
  });

  it("allows an absolute workdir outside the workspace", async () => {
    const root = await createRoot();
    const outside = await createRoot();

    await expect(resolveShellWorkdir(root, outside)).resolves.toBe(outside);
  });

  it("requires a workspace or an absolute workdir when the workspace is null", async () => {
    await expect(resolveShellWorkdir(null, undefined)).rejects.toMatchObject({
      code: "invalid-input",
      message: "执行命令前请先选择工作区目录，或提供绝对 workdir",
    });
    await expect(resolveShellWorkdir(null, "relative")).rejects.toMatchObject({
      code: "invalid-input",
      message: "使用相对 workdir 前请先选择工作区目录，或提供绝对 workdir",
    });
  });

  it("rejects drive-relative workdirs", async () => {
    const root = await createRoot();

    await expect(resolveShellWorkdir(root, "C:relative")).rejects.toMatchObject({
      code: "invalid-input",
      message: "workdir 不能是盘符相对形式",
    });
  });

  it("rejects missing and non-directory workdirs", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "file.txt"), "file", "utf8");

    await expect(resolveShellWorkdir(root, "missing")).rejects.toMatchObject({
      code: "invalid-input",
      message: "工作目录不存在：missing",
    });
    await expect(resolveShellWorkdir(root, "file.txt")).rejects.toMatchObject({
      code: "invalid-input",
      message: "工作目录不是目录：file.txt",
    });
  });

  async function createRoot(): Promise<string> {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "answra-workdir-test-")),
    );
    roots.push(root);
    return root;
  }
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliConfigError } from "../src/cli/errors";
import { resolveWorkspaceRoot } from "../src/config/workspace";

const created: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "answra-cli-workspace-"));
  created.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("resolveWorkspaceRoot", () => {
  it("resolves an existing directory to an absolute path", async () => {
    const directory = await temporaryDirectory();
    await expect(resolveWorkspaceRoot(directory)).resolves.toBe(path.resolve(directory));
  });

  it("rejects a missing directory", async () => {
    const directory = await temporaryDirectory();
    const missing = path.join(directory, "missing");
    await expect(resolveWorkspaceRoot(missing)).rejects.toThrowError(CliConfigError);
    await expect(resolveWorkspaceRoot(missing)).rejects.toThrowError(
      `工作目录不存在：${path.resolve(missing)}`,
    );
  });

  it("rejects a file path", async () => {
    const directory = await temporaryDirectory();
    const file = path.join(directory, "file.txt");
    await writeFile(file, "not a directory", "utf8");
    await expect(resolveWorkspaceRoot(file)).rejects.toThrowError("工作目录不是目录");
  });
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalShell } from "../../../../src/core/tool/builtin/runCommand/process/oneShot";

async function terminateDetachedChild(pidPath: string): Promise<void> {
  try {
    const pid = Number(await readFile(pidPath, "utf8"));
    if (Number.isInteger(pid) && pid > 0) process.kill(pid);
  } catch (error: unknown) {
    const code =
      error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== "ENOENT" && code !== "ESRCH") throw error;
  }
}

describe("LocalShell", () => {
  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      new LocalShell().run({ command: "echo hi", cwd: process.cwd() }, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError", message: "命令执行已取消" });
  });

  it("reports a spawn failure as an exit result with the error message", async () => {
    const missingCwd = path.join(process.cwd(), "definitely-missing-directory");

    const result = await new LocalShell().run({ command: "echo hi", cwd: missingCwd });

    expect(result.outcome).toEqual({ type: "exit", exitCode: 1 });
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("settles after the shell exits even when a descendant keeps stdout open", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "answra-shell-drain-"));
    const scriptPath = path.join(dir, "spawn-detached.cjs");
    const childPidPath = path.join(dir, "child.pid");
    await writeFile(
      scriptPath,
      [
        'const { spawn } = require("node:child_process");',
        'const fs = require("node:fs");',
        'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {',
        '  stdio: ["ignore", "inherit", "inherit"],',
        "  detached: true,",
        "});",
        "fs.writeFileSync(process.argv[2], String(child.pid));",
        "child.unref();",
        'console.log("root done");',
        "process.exit(0);",
      ].join("\n"),
    );
    const timeoutMs = 30_000;
    const command =
      process.platform === "win32"
        ? `& "${process.execPath}" "${scriptPath}" "${childPidPath}"`
        : `"${process.execPath}" "${scriptPath}" "${childPidPath}"`;

    try {
      const result = await new LocalShell().run({
        command,
        cwd: process.cwd(),
        timeoutMs,
      });

      expect(result.outcome).toEqual({ type: "exit", exitCode: 0 });
      expect(result.stdout).toContain("root done");
    } finally {
      await terminateDetachedChild(childPidPath);
      await rm(dir, { recursive: true, force: true });
    }
  }, 45_000);

  it("streams output deltas before the command settles", async () => {
    const deltas: string[] = [];

    const result = await new LocalShell().run({
      command: "echo hello",
      cwd: process.cwd(),
      onOutput: (delta) => deltas.push(delta),
    });

    expect(result.stdout).toContain("hello");
    expect(deltas.join("")).toContain("hello");
  }, 20_000);
});

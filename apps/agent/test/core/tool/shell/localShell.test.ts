import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalShell } from "../../../../src/core/tool/builtin/runCommand/process/oneShot";

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
    await writeFile(
      scriptPath,
      [
        'const { spawn } = require("node:child_process");',
        'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {',
        '  stdio: ["ignore", "inherit", "inherit"],',
        "  detached: true,",
        "});",
        "child.unref();",
        'console.log("root done");',
        "process.exit(0);",
      ].join("\n"),
    );
    const started = Date.now();
    const command =
      process.platform === "win32"
        ? `& "${process.execPath}" "${scriptPath}"`
        : `"${process.execPath}" "${scriptPath}"`;

    try {
      const result = await new LocalShell().run({
        command,
        cwd: process.cwd(),
        timeoutMs: 10_000,
      });

      expect(result.outcome).toEqual({ type: "exit", exitCode: 0 });
      expect(result.stdout).toContain("root done");
      expect(Date.now() - started).toBeLessThan(8_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

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

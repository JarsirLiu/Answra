import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalShell } from "../../../../src/core/tool/builtin/shell/localShell";

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

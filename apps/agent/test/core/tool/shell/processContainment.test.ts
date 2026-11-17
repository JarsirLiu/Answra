import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { terminateProcessTree } from "../../../../src/core/tool/builtin/runCommand/process/containment";
import {
  buildWindowsJobBootstrap,
  JOB_MARKER_ENV,
  parseJobContainmentMarker,
} from "../../../../src/core/tool/builtin/runCommand/process/windows";

describe("shell process tree", () => {
  it("parses Job containment marker values", () => {
    expect(parseJobContainmentMarker("True")).toBe("ok");
    expect(parseJobContainmentMarker("True\r\n")).toBe("ok");
    expect(parseJobContainmentMarker("False")).toBe("failed");
    expect(parseJobContainmentMarker("false")).toBe("failed");
    expect(parseJobContainmentMarker("")).toBe("unknown");
    expect(parseJobContainmentMarker("garbage")).toBe("unknown");
  });

  it("embeds the Windows Job Object flags and reports containment through the marker", () => {
    const bootstrap = buildWindowsJobBootstrap();
    expect(bootstrap).toContain(`$env:${JOB_MARKER_ENV}`);
    expect(bootstrap).toContain("Set-Content");

    const base64 = bootstrap.match(/FromBase64String\('([^']+)'\)/)?.[1];
    if (!base64) throw new Error("Job bootstrap is missing its embedded C# source");
    const source = Buffer.from(base64, "base64").toString("utf8");
    expect(source).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE");
    expect(source).toContain("JOB_OBJECT_LIMIT_BREAKAWAY_OK");
    expect(source).toContain("AssignProcessToJobObject");
    expect(source).toContain("SetInformationJobObject");
  });

  it("escalates to SIGKILL when the POSIX process group ignores SIGTERM", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(path.join(os.tmpdir(), "answra-shell-signal-"));
    try {
      const script = path.join(workspace, "ignore-term.mjs");
      await writeFile(
        script,
        [
          "process.on('SIGTERM', () => {})",
          "process.stdout.write('ready\\n')",
          "setInterval(() => {}, 1_000)",
        ].join("\n"),
        "utf8",
      );
      const child = spawn(process.execPath, [script], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (!child.stdout) throw new Error("child stdout is unavailable");
      await once(child.stdout, "data");
      const exited = once(child, "exit");
      const startedAt = Date.now();

      await terminateProcessTree(child);
      const [, signal] = await exited;

      expect(signal).toBe("SIGKILL");
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_500);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 10_000);

  it("terminates a cooperative POSIX process group without waiting for escalation", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(path.join(os.tmpdir(), "answra-shell-signal-"));
    try {
      const script = path.join(workspace, "wait.mjs");
      await writeFile(
        script,
        ["process.stdout.write('ready\\n')", "setInterval(() => {}, 1_000)"].join("\n"),
        "utf8",
      );
      const child = spawn(process.execPath, [script], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (!child.stdout) throw new Error("child stdout is unavailable");
      await once(child.stdout, "data");
      const exited = once(child, "exit");
      const startedAt = Date.now();

      await terminateProcessTree(child);
      const [, signal] = await exited;

      expect(signal).toBe("SIGTERM");
      expect(Date.now() - startedAt).toBeLessThan(1_500);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 10_000);
});

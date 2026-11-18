import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { terminateProcessTree } from "../../../../src/core/tool/builtin/runCommand/process/containment";
import { spawnShellProcess } from "../../../../src/core/tool/builtin/runCommand/process/spawn";
import { parseJobContainmentMarker } from "../../../../src/core/tool/builtin/runCommand/process/windows";

async function waitForFile(filePath: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await readFile(filePath);
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error(`waiting for marker timed out: ${filePath}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

describe("shell process spawn", () => {
  it("reports Job Object containment state for a one-shot command on Windows", async () => {
    if (process.platform !== "win32") return;
    const handle = spawnShellProcess({
      command: "Start-Sleep -Seconds 30",
      cwd: process.cwd(),
      stdin: "ignore",
    });
    if (!handle.jobMarkerPath) throw new Error("expected a Windows Job Object marker");
    await waitForFile(handle.jobMarkerPath);
    const marker = await readFile(handle.jobMarkerPath, "utf8");

    expect(parseJobContainmentMarker(marker)).not.toBe("unknown");

    const closed = once(handle.child, "close");
    await terminateProcessTree(handle.child, handle.jobMarkerPath);
    await closed;
  }, 30_000);
});

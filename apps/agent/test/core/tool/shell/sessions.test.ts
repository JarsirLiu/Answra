import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeShellYieldTime,
  ShellSessionManager,
  type ShellSessionSnapshot,
  type ShellYieldTimePolicy,
} from "../../../../src/core/tool/builtin/shell/sessions";

const managers: ShellSessionManager[] = [];
const workspaces: string[] = [];

async function createHarness(): Promise<{
  readonly manager: ShellSessionManager;
  readonly workspace: string;
}> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "answra-shell-session-"));
  const manager = new ShellSessionManager({ yieldTimePolicy: bypassYieldTimePolicy });
  managers.push(manager);
  workspaces.push(workspace);
  return { manager, workspace };
}

function bypassYieldTimePolicy(options: Parameters<ShellYieldTimePolicy>[0]): number {
  return options.requestedMs ?? 10_000;
}

async function writeScript(workspace: string, name: string, source: string): Promise<string> {
  const scriptPath = path.join(workspace, name);
  await writeFile(scriptPath, source, "utf8");
  return nodeCommand(scriptPath);
}

function nodeCommand(scriptPath: string): string {
  if (process.platform === "win32")
    return `& ${quotePowerShell(process.execPath)} ${quotePowerShell(scriptPath)}`;
  return `${quotePosix(process.execPath)} ${quotePosix(scriptPath)}`;
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function combineOutput(...snapshots: readonly ShellSessionSnapshot[]): string {
  return snapshots.map((snapshot) => snapshot.stdout).join("");
}

async function waitForCompletion(
  manager: ShellSessionManager,
  started: ShellSessionSnapshot,
  timeoutMs = 15_000,
): Promise<{
  readonly result: ShellSessionSnapshot;
  readonly stdout: string;
  readonly stderr: string;
}> {
  let result = started;
  const stdout = [started.stdout];
  const stderr = [started.stderr];
  const deadline = Date.now() + timeoutMs;
  while (result.status === "running") {
    if (Date.now() >= deadline) throw new Error("会话未在测试期限内完成。");
    result = await manager.writeStdin({
      sessionId: requireSessionId(started),
      yieldTimeMs: 1_000,
    });
    stdout.push(result.stdout);
    stderr.push(result.stderr);
  }
  return { result, stdout: stdout.join(""), stderr: stderr.join("") };
}

function requireSessionId(snapshot: ShellSessionSnapshot): string {
  if (!snapshot.sessionId) throw new Error("运行中的会话缺少 sessionId。");
  return snapshot.sessionId;
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

// cleanup 的 shutdown cap（5 秒）与 Windows 目录句柄释放重试叠加，
// 负载下可能超过默认 10 秒钩子超时，显式放宽。
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.cleanup()));
  await Promise.all(workspaces.splice(0).map((workspace) => removeWorkspace(workspace)));
}, 30_000);

/**
 * Windows 下子进程退出后其 CWD 目录句柄才释放，rm 可能瞬时 EBUSY/EPERM。
 * cleanup 的 5 秒 shutdown cap 到期时进程可能仍存活，因此对删除做重试直到成功。
 */
async function removeWorkspace(workspace: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await rm(workspace, { recursive: true, force: true });
      return;
    } catch (error: unknown) {
      const retryable =
        error instanceof Error &&
        ["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        );
      if (!retryable || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function registerConfigurationTests(): void {
  it("tiers and caps the foreground wait time", () => {
    expect(normalizeShellYieldTime({ phase: "start", hasInput: false, requestedMs: 1 })).toBe(
      process.platform === "win32" ? 10_000 : 250,
    );
    expect(normalizeShellYieldTime({ phase: "start", hasInput: false, requestedMs: 60_000 })).toBe(
      30_000,
    );
    expect(normalizeShellYieldTime({ phase: "write", hasInput: true, requestedMs: 1 })).toBe(250);
    expect(normalizeShellYieldTime({ phase: "write", hasInput: true, requestedMs: 60_000 })).toBe(
      30_000,
    );
    expect(normalizeShellYieldTime({ phase: "write", hasInput: false, requestedMs: 1 })).toBe(
      5_000,
    );
    expect(normalizeShellYieldTime({ phase: "write", hasInput: false, requestedMs: 600_000 })).toBe(
      300_000,
    );
  });

  it("rejects a session capacity above the production limit", () => {
    expect(() => new ShellSessionManager({ maxSessions: 33 })).toThrow(/1 到 32/);
  });

  it("rejects an invalid explicit timeoutMs", async () => {
    const { manager, workspace } = await createHarness();
    const command = await writeScript(
      workspace,
      "invalid-timeout.mjs",
      "process.stdout.write('done')",
    );

    await expect(manager.start({ command, cwd: workspace, timeoutMs: 0 })).rejects.toThrow(
      /timeoutMs.*正整数/,
    );
  });
}

function registerCompletionTests(): void {
  it("returns output and exit code when the command finishes inside the wait window", async () => {
    const { manager, workspace } = await createHarness();
    const command = await writeScript(workspace, "complete.mjs", "process.stdout.write('done')");
    const result = await manager.start({ command, cwd: workspace, yieldTimeMs: 20_000 });

    expect(result).toMatchObject({
      status: "completed",
      stdout: "done",
      stderr: "",
      exitCode: 0,
    });
    expect(result.sessionId).toBeTypeOf("string");

    const reread = await manager.writeStdin({
      sessionId: requireSessionId(result),
      yieldTimeMs: 1,
    });
    expect(reread).toMatchObject({
      status: "completed",
      sessionId: result.sessionId,
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
  }, 30_000);

  it("returns a session for a long command and reads incremental output to completion", async () => {
    const { manager, workspace } = await createHarness();
    const command = await writeScript(
      workspace,
      "incremental.mjs",
      [
        "process.stdout.write('first\\n')",
        "setTimeout(() => process.stdout.write('second\\n'), 250)",
        "setTimeout(() => process.stdout.write('third\\n'), 500)",
      ].join("\n"),
    );

    const started = await manager.start({
      command,
      cwd: workspace,
      yieldTimeMs: 50,
      timeoutMs: 20_000,
    });
    expect(started.status).toBe("running");
    expect(started.sessionId).toBeTypeOf("string");

    const snapshots = [started];
    let finished = await manager.writeStdin({
      sessionId: requireSessionId(started),
      yieldTimeMs: 300,
    });
    snapshots.push(finished);
    const deadline = Date.now() + 15_000;
    while (finished.status === "running") {
      if (Date.now() >= deadline) throw new Error("增量读取会话未在测试期限内完成。");
      finished = await manager.writeStdin({
        sessionId: requireSessionId(started),
        yieldTimeMs: 2_000,
      });
      snapshots.push(finished);
    }

    expect(finished).toMatchObject({ status: "completed", exitCode: 0 });
    const output = combineOutput(...snapshots);
    expect(output.match(/first/g)).toHaveLength(1);
    expect(output.match(/second/g)).toHaveLength(1);
    expect(output.match(/third/g)).toHaveLength(1);
  });
}

function registerStdinTests(): void {
  it("writes text to a regular pipe command", async () => {
    const { manager, workspace } = await createHarness();
    const command = await writeScript(
      workspace,
      "stdin.mjs",
      [
        "process.stdin.setEncoding('utf8')",
        "process.stdin.once('data', (chunk) => {",
        "  process.stdout.write('received:' + chunk.trim())",
        "  process.exit(0)",
        "})",
      ].join("\n"),
    );
    const started = await manager.start({
      command,
      cwd: workspace,
      yieldTimeMs: 100,
      timeoutMs: 20_000,
    });
    const first = await manager.writeStdin({
      sessionId: requireSessionId(started),
      chars: "hello\n",
      yieldTimeMs: 3_000,
    });
    const { result, stdout } = await waitForCompletion(manager, first);

    expect(result).toMatchObject({ status: "completed", exitCode: 0 });
    expect(`${started.stdout}${stdout}`).toContain("received:hello");
  });
}

function registerCwdTests(): void {
  it("starts the command in the provided cwd", async () => {
    const { manager, workspace } = await createHarness();
    const nested = path.join(workspace, "nested");
    await mkdir(nested);
    const command = await writeScript(
      workspace,
      "workdir.mjs",
      ["process.stdout.write(process.cwd())", "setTimeout(() => process.exit(0), 100)"].join("\n"),
    );
    const started = await manager.start({
      command,
      cwd: nested,
      yieldTimeMs: 20,
      timeoutMs: 20_000,
    });
    const snapshots = [started];
    let finished = started;
    const deadline = Date.now() + 15_000;
    while (finished.status === "running") {
      if (Date.now() >= deadline) throw new Error("workdir 会话未在测试期限内完成。");
      finished = await manager.writeStdin({
        sessionId: requireSessionId(finished),
        yieldTimeMs: 250,
      });
      snapshots.push(finished);
    }

    expect(combineOutput(...snapshots).toLowerCase()).toMatch(/nested$/);
    expect(finished.status).toBe("completed");
  });
}

function registerBoundaryTests(): void {
  it("rejects forged session IDs from other manager instances", async () => {
    const first = await createHarness();
    const second = await createHarness();
    const command = await writeScript(first.workspace, "long.mjs", "setTimeout(() => {}, 5_000)");
    const started = await first.manager.start({
      command,
      cwd: first.workspace,
      yieldTimeMs: 50,
    });

    await expect(
      second.manager.writeStdin({ sessionId: requireSessionId(started), yieldTimeMs: 10 }),
    ).rejects.toThrow(/Shell session 不存在/);
    await expect(
      first.manager.writeStdin({ sessionId: "forged-session", yieldTimeMs: 10 }),
    ).rejects.toThrow(/Shell session 不存在/);
  });

  it("terminates the session and reports timed_out when timeoutMs expires", async () => {
    const { manager, workspace } = await createHarness();
    const command = await writeScript(workspace, "timeout.mjs", "setInterval(() => {}, 1_000)");
    const started = await manager.start({
      command,
      cwd: workspace,
      yieldTimeMs: 50,
      timeoutMs: 250,
    });
    const finished = await manager.writeStdin({
      sessionId: requireSessionId(started),
      yieldTimeMs: 2_000,
    });

    expect(finished).toMatchObject({
      status: "timed_out",
      exitCode: null,
      signal: "SIGTERM",
    });
    const reread = await manager.writeStdin({
      sessionId: requireSessionId(started),
      yieldTimeMs: 10,
    });
    expect(reread).toMatchObject({
      status: "timed_out",
      sessionId: started.sessionId,
      exitCode: null,
      signal: "SIGTERM",
    });
  });

  it("does not apply a default timeout to a persistent session", async () => {
    const { manager, workspace } = await createHarness();
    const command = await writeScript(workspace, "persistent.mjs", "setInterval(() => {}, 1_000)");
    const started = await manager.start({ command, cwd: workspace, yieldTimeMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const reread = await manager.writeStdin({
      sessionId: requireSessionId(started),
      yieldTimeMs: 50,
    });

    expect(reread).toMatchObject({ status: "running", sessionId: started.sessionId });
  });
}

function registerAbortTests(): void {
  it("ends start with AbortError when the run signal is cancelled", async () => {
    const { manager, workspace } = await createHarness();
    const command = await writeScript(workspace, "abort-start.mjs", "setInterval(() => {}, 1_000)");
    const controller = new AbortController();
    const pending = manager.start({
      command,
      cwd: workspace,
      yieldTimeMs: 5_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels a writeStdin wait", async () => {
    const { manager, workspace } = await createHarness();
    const command = await writeScript(workspace, "abort-write.mjs", "setInterval(() => {}, 1_000)");
    const started = await manager.start({ command, cwd: workspace, yieldTimeMs: 50 });
    const controller = new AbortController();
    const pending = manager.writeStdin({
      sessionId: requireSessionId(started),
      yieldTimeMs: 5_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
}

function registerConcurrencyTests(): void {
  it("serializes concurrent polls and never repeats output", async () => {
    const { manager, workspace } = await createHarness();
    const command = await writeScript(
      workspace,
      "parallel.mjs",
      [
        "setTimeout(() => process.stdout.write('one\\n'), 150)",
        "setTimeout(() => process.stdout.write('two\\n'), 350)",
        "setTimeout(() => process.stdout.write('three\\n'), 550)",
      ].join("\n"),
    );
    const started = await manager.start({
      command,
      cwd: workspace,
      yieldTimeMs: 50,
      timeoutMs: 20_000,
    });
    const first = manager.writeStdin({
      sessionId: requireSessionId(started),
      yieldTimeMs: 250,
    });
    const second = manager.writeStdin({
      sessionId: requireSessionId(started),
      yieldTimeMs: 2_000,
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    let finished = secondResult;
    const deadline = Date.now() + 15_000;
    while (finished.status === "running") {
      if (Date.now() >= deadline) throw new Error("并发轮询会话未在测试期限内完成。");
      finished = await manager.writeStdin({
        sessionId: requireSessionId(started),
        yieldTimeMs: 500,
      });
    }

    const output = combineOutput(
      started,
      firstResult,
      secondResult,
      ...(finished === secondResult ? [] : [finished]),
    );
    expect(finished).toMatchObject({ status: "completed", exitCode: 0 });
    expect(output.match(/one/g)).toHaveLength(1);
    expect(output.match(/two/g)).toHaveLength(1);
    expect(output.match(/three/g)).toHaveLength(1);
  });
}

function registerOutputTruncationTests(): void {
  it("reports a truncated response and does not split Unicode characters", async () => {
    const { manager, workspace } = await createHarness();
    const command = await writeScript(
      workspace,
      "truncate.mjs",
      "process.stdout.write('开始中文内容'.repeat(100) + '结束')",
    );
    const result = await manager.start({
      command,
      cwd: workspace,
      yieldTimeMs: 5_000,
      maxOutputLength: 80,
    });

    expect(result).toMatchObject({ status: "completed", outputTruncated: true });
    expect(result.stdout).toMatch(/^开始/);
    expect(result.stdout).toMatch(/结束$/);
    expect(result.stdout).toContain("output truncated");
    expect(result.stdout).not.toContain("\uFFFD");
  });

  it("reports omitted bytes when cumulative output reaches the limit", async () => {
    const { manager, workspace } = await createHarness();
    const command = await writeScript(
      workspace,
      "output-cap.mjs",
      "process.stdout.write('x'.repeat(11 * 1024 * 1024))",
    );
    const result = await manager.start({ command, cwd: workspace, yieldTimeMs: 5_000 });

    expect(result.outputTruncated).toBe(true);
    expect(result.outputOmittedBytes).toBeGreaterThan(0);
  });
}

function registerCapacityEvictionTests(): void {
  it("evicts the least recently used session at capacity", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "answra-shell-session-capacity-"));
    const manager = new ShellSessionManager({
      maxSessions: 9,
      yieldTimePolicy: bypassYieldTimePolicy,
    });
    managers.push(manager);
    workspaces.push(workspace);
    // 单进程 PowerShell 常驻，避免 PowerShell→Node 孙进程在并发拆除时逃逸成孤儿。
    const command = "Start-Sleep -Seconds 30";
    const sessions: ShellSessionSnapshot[] = [];
    for (let index = 0; index < 9; index += 1) {
      sessions.push(await manager.start({ command, cwd: workspace, yieldTimeMs: 1 }));
    }

    const oldest = sessions[0];
    const secondOldest = sessions[1];
    if (!oldest?.sessionId || !secondOldest?.sessionId)
      throw new Error("容量测试未创建运行中的会话。");
    await manager.writeStdin({ sessionId: oldest.sessionId, yieldTimeMs: 1 });
    const replacement = await manager.start({ command, cwd: workspace, yieldTimeMs: 1 });

    expect(replacement.status).toBe("running");
    await manager.writeStdin({ sessionId: oldest.sessionId, yieldTimeMs: 1 });
    await expect(
      manager.writeStdin({ sessionId: secondOldest.sessionId, yieldTimeMs: 1 }),
    ).rejects.toThrow(/Shell session 不存在/);
  });
}

function registerCapacityFinishedPreferenceTests(): void {
  it("prefers finished sessions when evicting at capacity", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "answra-shell-session-finished-capacity-"),
    );
    const manager = new ShellSessionManager({
      maxSessions: 9,
      yieldTimePolicy: bypassYieldTimePolicy,
    });
    managers.push(manager);
    workspaces.push(workspace);
    // 运行中用常驻 Start-Sleep，已结束用短 Start-Sleep 自然退出，均为单进程 PowerShell。
    const finishedCommand = "Start-Sleep -Milliseconds 100";
    const runningCommand = "Start-Sleep -Seconds 30";
    const running: ShellSessionSnapshot[] = [
      await manager.start({
        command: runningCommand,
        cwd: workspace,
        yieldTimeMs: 1,
        timeoutMs: 30_000,
      }),
    ];
    const finished = await manager.start({
      command: finishedCommand,
      cwd: workspace,
      yieldTimeMs: 1,
      timeoutMs: 30_000,
    });
    if (!finished.sessionId) throw new Error("容量测试未创建待结束会话。");
    for (let index = 2; index < 9; index += 1) {
      running.push(
        await manager.start({
          command: runningCommand,
          cwd: workspace,
          yieldTimeMs: 1,
          timeoutMs: 30_000,
        }),
      );
    }
    const oldestRunning = running[0];
    if (!oldestRunning?.sessionId) throw new Error("容量测试未创建最早运行会话。");
    await manager.writeStdin({ sessionId: oldestRunning.sessionId, yieldTimeMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const replacement = await manager.start({
      command: runningCommand,
      cwd: workspace,
      yieldTimeMs: 1,
      timeoutMs: 30_000,
    });

    expect(replacement.status).toBe("running");
    await expect(
      manager.writeStdin({ sessionId: finished.sessionId, yieldTimeMs: 1 }),
    ).rejects.toThrow(/Shell session 不存在/);
    const stillRunning = running[1];
    if (!stillRunning?.sessionId) throw new Error("容量测试未创建运行中的会话。");
    await manager.writeStdin({ sessionId: stillRunning.sessionId, yieldTimeMs: 1 });
  });
}

function registerStderrCleanupTests(): void {
  it("removes the PowerShell script echo and location block from session stderr", async () => {
    if (process.platform !== "win32") return;
    const { manager, workspace } = await createHarness();
    const started = await manager.start({
      command: 'Write-Error "中文错误"',
      cwd: workspace,
      yieldTimeMs: 1_000,
    });
    const { result, stderr } = await waitForCompletion(manager, started);

    expect(result.status).toBe("completed");
    expect(stderr).toContain("中文错误");
    expect(stderr).not.toMatch(
      /CategoryInfo|FullyQualifiedErrorId|\[Console\]::|所在位置|At line:/,
    );
  });
}

function registerCleanupTests(): void {
  it("cleanup terminates a running process tree", async () => {
    const { manager, workspace } = await createHarness();
    const readyMarker = path.join(workspace, "ready.txt");
    const leakMarker = path.join(workspace, "should-not-exist.txt");
    const command = await writeScript(
      workspace,
      "cleanup.mjs",
      [
        "import { writeFile } from 'node:fs/promises'",
        `await writeFile(${JSON.stringify(readyMarker)}, 'ready')`,
        `setTimeout(() => writeFile(${JSON.stringify(leakMarker)}, 'leaked'), 2_500)`,
        "setTimeout(() => {}, 5_000)",
      ].join("\n"),
    );
    const started = await manager.start({ command, cwd: workspace, yieldTimeMs: 400 });
    expect(started.status).toBe("running");
    await waitUntil(() => exists(readyMarker));
    await manager.cleanup();
    await new Promise((resolve) => setTimeout(resolve, 2_800));
    expect(await exists(leakMarker)).toBe(false);
  });
}

describe("ShellSessionManager", { timeout: 30_000 }, () => {
  registerConfigurationTests();
  registerCompletionTests();
  registerStdinTests();
  registerCwdTests();
  registerBoundaryTests();
  registerAbortTests();
  registerConcurrencyTests();
  registerOutputTruncationTests();
  registerCapacityEvictionTests();
  registerCapacityFinishedPreferenceTests();
  registerStderrCleanupTests();
  registerCleanupTests();
});
